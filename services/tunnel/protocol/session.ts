/**
 * Debugg tunnel wire protocol v1 — the multiplexed session.
 *
 * One TunnelSession owns one websocket and every stream on it. The two roles are
 * asymmetric in exactly two ways: only a 'server' session opens streams and
 * answers PROBEs, and only a 'client' session receives streams and sends PROBEs.
 * Everything else — flow control, scheduling, liveness, GOAWAY — is symmetric.
 *
 * Events:
 *   'stream' (stream: TunnelStream)          client role: the peer opened a stream
 *   'goaway' (info: GoAwayInfo)              the peer is shutting down
 *   'close'  (info: SessionCloseInfo)        the session is over; fires exactly once
 *   'error'  (err: Error)                    non-fatal diagnostics, only if listened for
 *
 * Spec: bead debugg_ai_mcp-xkoh.1.2.
 */

import { EventEmitter } from 'node:events';
import {
  decodeFrame,
  encodeFrame,
  type Frame,
  type OpenMetadata,
  type ProbeRequest,
  type ProbeResult,
} from './codec.js';
import { ProtocolError, SessionClosedError, StreamResetError } from './errors.js';
import { TunnelStream, type StreamHost } from './stream.js';
import type { FrameTransport } from './transport.js';
import {
  CLOSE_CODE_BASE,
  CloseCode,
  DEAD_PEER_TIMEOUT_MS,
  ErrorCode,
  INITIAL_WINDOW,
  MAX_CONCURRENT_STREAMS,
  MAX_DATA_PAYLOAD,
  MAX_GOAWAY_REASON_BYTES,
  MAX_STREAM_ID,
  MAX_UNACKED_SEND_BYTES,
  MAX_WINDOW,
  PING_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  WINDOW_UPDATE_THRESHOLD,
} from './constants.js';

export type SessionRole = 'client' | 'server';

export interface TunnelSessionOptions {
  role: SessionRole;
  /** Defaults to PING_INTERVAL_MS. Lowered in tests. */
  pingIntervalMs?: number;
  /** Defaults to DEAD_PEER_TIMEOUT_MS. */
  deadPeerTimeoutMs?: number;
  /** Server role: answers a client's PROBE. */
  onProbe?: (request: ProbeRequest) => Promise<ProbeResult>;
}

export interface GoAwayInfo {
  code: number;
  reason: string;
}

export interface SessionCloseInfo {
  /** Websocket close code: 1000 when drained, 4000 + ErrorCode, or 1006 if abrupt. */
  closeCode: number;
  reason: string;
  /** True when the peer closed us. */
  remote: boolean;
}

export interface GoAwayOptions {
  /** Defaults to ErrorCode.GOING_AWAY. */
  code?: number;
  reason?: string;
  /** Streams still open after this are RST and the socket closes. */
  drainTimeoutMs?: number;
}

/**
 * How long a GOAWAY'd session waits before giving up on the drain. A server
 * should pass its own (ECS stopTimeout); this default only exists so a session
 * that goes away with nothing to drain still closes eventually.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

interface WriteJob {
  chunk: Buffer;
  offset: number;
  cb: (err?: Error | null) => void;
}

interface StreamRecord {
  stream: TunnelStream;
  /** Bytes we may still send before we need a WINDOW. */
  sendWindow: number;
  /** Bytes the peer may still send us. */
  receiveAllowance: number;
  /** Consumed by the application but not yet granted back. */
  unannounced: number;
  queue: WriteJob[];
  finalPending: boolean;
  finalCb: ((err?: Error | null) => void) | undefined;
  endSent: boolean;
  endReceived: boolean;
  /** The session is tearing this stream down, so _destroy must not RST back. */
  suppressReset: boolean;
  /** Currently in the round-robin ring. */
  queued: boolean;
}

const KNOWN_ERROR_CODES = new Set<number>(Object.values(ErrorCode));

/** Unknown codes must never be special-cased; they read as a plain reset. */
function normalizeResetCode(code: number): number {
  return KNOWN_ERROR_CODES.has(code) ? code : ErrorCode.RESET;
}

function truncateReason(reason: string): string {
  const buf = Buffer.from(reason, 'utf8');
  return buf.length <= MAX_GOAWAY_REASON_BYTES ? reason : buf.subarray(0, MAX_GOAWAY_REASON_BYTES).toString('utf8');
}

function unref(timer: NodeJS.Timeout): NodeJS.Timeout {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

export class TunnelSession extends EventEmitter implements StreamHost {
  readonly role: SessionRole;

  private readonly transport: FrameTransport;
  private readonly onProbe: ((request: ProbeRequest) => Promise<ProbeResult>) | undefined;
  private readonly streams = new Map<number, StreamRecord>();
  /** Round-robin ring of stream ids with something to send. */
  private readonly ready: number[] = [];
  /** Control frames jump ahead of queued DATA. */
  private readonly control: Buffer[] = [];
  private readonly pendingPings = new Map<
    string,
    { resolve: (rtt: number) => void; reject: (err: Error) => void; sentAt: number }
  >();
  private readonly pendingProbes = new Map<
    number,
    { resolve: (result: ProbeResult) => void; timer: NodeJS.Timeout; startedAt: number }
  >();
  private readonly goAwayWaiters: Array<() => void> = [];

  private unackedBytes = 0;
  private pumping = false;
  private nextStreamId = 1;
  private highestStreamId = 0;
  private nextProbeId = 1;
  private nextNonce = 1n;
  private goAwaySent = false;
  private goAwayReceived = false;
  private drainStarted = false;
  private isClosed = false;
  private closeCode: number | undefined;

  private readonly pingIntervalMs: number;
  private readonly deadPeerTimeoutMs: number;
  private pingTimer: NodeJS.Timeout | undefined;
  private deadTimer: NodeJS.Timeout | undefined;
  private drainTimer: NodeJS.Timeout | undefined;

  constructor(transport: FrameTransport, options: TunnelSessionOptions) {
    super();
    this.role = options.role;
    this.transport = transport;
    this.onProbe = options.onProbe;
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.deadPeerTimeoutMs = options.deadPeerTimeoutMs ?? DEAD_PEER_TIMEOUT_MS;

    transport.setHandlers({
      onFrame: (bytes) => this.handleBytes(bytes),
      onInvalidMessage: (detail) => this.fatal(ErrorCode.PROTOCOL_ERROR, `not a protocol frame: ${detail}`),
      onClose: (code, reason) => this.finish(code, reason, true),
    });

    this.pingTimer = unref(
      setInterval(() => {
        // Liveness only: no RTT to report, so no promise to leave dangling.
        this.queueControl({ type: 'PING', streamId: 0, nonce: this.nextNonce++ });
      }, this.pingIntervalMs),
    );
    this.armDeadPeerTimer();
  }

  /** Streams that are not yet fully closed, i.e. what counts against the cap. */
  get activeStreamCount(): number {
    return this.streams.size;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Server role only. Throws StreamResetError(REFUSED) at MAX_CONCURRENT_STREAMS
   * or once GOAWAY has been sent or received, and SessionClosedError once closed.
   */
  openStream(metadata: OpenMetadata = {}): TunnelStream {
    if (this.role !== 'server') throw new Error('only a server session opens streams');
    if (this.isClosed) throw new SessionClosedError(this.closeCode ?? CloseCode.GOING_AWAY);
    if (this.goAwaySent || this.goAwayReceived) {
      throw new StreamResetError(ErrorCode.REFUSED, 'session is going away', false);
    }
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      throw new StreamResetError(ErrorCode.REFUSED, `already at ${MAX_CONCURRENT_STREAMS} concurrent streams`, false);
    }
    if (this.nextStreamId > MAX_STREAM_ID) {
      throw new StreamResetError(ErrorCode.REFUSED, 'stream ids exhausted; reconnect', false);
    }

    const streamId = this.nextStreamId++;
    this.highestStreamId = streamId;
    // encodeFrame normalises the metadata, so nothing address-shaped is emitted.
    const open: Frame = { type: 'OPEN', streamId, metadata };
    const record = this.createRecord(streamId, decodeFrame(encodeFrame(open)) as Extract<Frame, { type: 'OPEN' }>);
    this.queueControl(open);
    return record.stream;
  }

  /** Send PING; resolves with the round trip in ms when the PONG comes back. */
  ping(): Promise<number> {
    if (this.isClosed) return Promise.reject(new SessionClosedError(this.closeCode ?? CloseCode.NORMAL));
    const nonce = this.nextNonce++;
    const sentAt = Date.now();
    return new Promise<number>((resolve, reject) => {
      this.pendingPings.set(nonce.toString(), { resolve, reject, sentAt });
      this.queueControl({ type: 'PING', streamId: 0, nonce });
    });
  }

  /**
   * Client role only. Never throws or rejects — a deadline resolves
   * `{ error: 'TIMEOUT' }` and a closed session `{ error: 'CLOSED' }`, because
   * probeTunnelHealth's contract is that a probe always answers.
   */
  probe(path: string, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
    if (this.role !== 'client') throw new Error('only a client session sends probes');
    const startedAt = Date.now();
    if (this.isClosed) return Promise.resolve({ error: 'CLOSED', elapsedMs: 0 });

    const probeId = this.nextProbeId++;
    const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    return new Promise<ProbeResult>((resolve) => {
      const timer = unref(
        setTimeout(() => {
          this.pendingProbes.delete(probeId);
          resolve({ error: 'TIMEOUT', elapsedMs: Date.now() - startedAt });
        }, timeoutMs),
      );
      this.pendingProbes.set(probeId, { resolve, timer, startedAt });
      this.queueControl({ type: 'PROBE', streamId: probeId, request: { path } });
    });
  }

  /**
   * Send GOAWAY, refuse further OPENs in both directions, and close once every
   * open stream has finished or the drain deadline passes.
   */
  goAway(opts: GoAwayOptions = {}): Promise<void> {
    if (this.isClosed) return Promise.resolve();
    if (!this.goAwaySent) {
      this.goAwaySent = true;
      this.drainStarted = true;
      this.queueControl({
        type: 'GOAWAY',
        streamId: 0,
        code: opts.code ?? ErrorCode.GOING_AWAY,
        reason: truncateReason(opts.reason ?? ''),
      });
      // The socket deliberately stays open even with nothing to drain: the peer
      // may still have OPENs in flight, and those must be refused rather than
      // dropped on the floor.
      this.drainTimer = unref(setTimeout(() => this.endDrain(true), opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS));
    }
    return new Promise<void>((resolve) => {
      this.goAwayWaiters.push(resolve);
    });
  }

  /** Tear the session down now: fail open streams and close the socket. */
  close(code: number = ErrorCode.GOING_AWAY, reason = ''): void {
    if (this.isClosed) return;
    this.sendImmediate({ type: 'GOAWAY', streamId: 0, code, reason: truncateReason(reason) });
    this.closeTransport(CLOSE_CODE_BASE + code, reason);
  }

  // ── StreamHost (called by TunnelStream) ────────────────────────────────────

  streamWrite(stream: TunnelStream, chunk: Buffer, cb: (err?: Error | null) => void): void {
    const record = this.streams.get(stream.id);
    if (!record) {
      // The stream is already gone (session closed, or reset). Settling without
      // an error is deliberate: node turns an error handed to a write callback
      // into an 'error' on the stream, which would be a second report of a
      // teardown the stream is already reporting — and a crash if the consumer
      // only listened for 'close'.
      cb(null);
      return;
    }
    if (chunk.length === 0) {
      cb(null);
      return;
    }
    record.queue.push({ chunk, offset: 0, cb });
    this.markReady(record);
    this.pump();
  }

  streamFinal(stream: TunnelStream, cb: (err?: Error | null) => void): void {
    const record = this.streams.get(stream.id);
    if (!record) {
      cb(null);
      return;
    }
    record.finalPending = true;
    record.finalCb = cb;
    this.markReady(record);
    this.pump();
  }

  streamDestroy(stream: TunnelStream, err: Error | null, resetCode: number | undefined): void {
    const record = this.streams.get(stream.id);
    if (!record) return;
    this.streams.delete(stream.id);

    // Settled without an error on purpose: the stream is being destroyed in the
    // same breath, and handing an error to a write callback makes node emit a
    // SECOND 'error' on a stream that is already reporting the real one.
    this.settleJobs(record);

    if (!record.suppressReset) {
      const code =
        resetCode ?? (err instanceof StreamResetError ? err.code : err ? ErrorCode.RESET : ErrorCode.RESET);
      this.queueControl({ type: 'RST', streamId: stream.id, code });
    }
    this.afterStreamClosed();
  }

  streamConsumed(stream: TunnelStream, bytes: number): void {
    const record = this.streams.get(stream.id);
    if (!record) return;
    record.unannounced += bytes;
    if (record.unannounced >= WINDOW_UPDATE_THRESHOLD) {
      const increment = record.unannounced;
      record.unannounced = 0;
      record.receiveAllowance += increment;
      this.queueControl({ type: 'WINDOW', streamId: stream.id, increment });
    }
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  private handleBytes(bytes: Uint8Array): void {
    if (this.isClosed) return;
    this.armDeadPeerTimer();
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      this.fatal(ErrorCode.PROTOCOL_ERROR, err instanceof ProtocolError ? err.message : String(err));
      return;
    }
    this.handleFrame(frame);
  }

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case 'OPEN':
        this.handleOpen(frame);
        return;
      case 'DATA': {
        const record = this.lookup(frame.streamId);
        if (!record) return;
        if (record.endReceived) {
          this.resetStream(record, ErrorCode.PROTOCOL_ERROR, 'DATA after END');
          return;
        }
        if (frame.data.length > record.receiveAllowance) {
          this.resetStream(record, ErrorCode.PROTOCOL_ERROR, 'flow control window overrun');
          return;
        }
        record.receiveAllowance -= frame.data.length;
        if (!record.stream.destroyed) record.stream.deliver(frame.data);
        return;
      }
      case 'END': {
        const record = this.lookup(frame.streamId);
        if (!record) return;
        if (record.endReceived) {
          this.resetStream(record, ErrorCode.PROTOCOL_ERROR, 'duplicate END');
          return;
        }
        record.endReceived = true;
        if (!record.stream.destroyed) record.stream.deliverEnd();
        this.maybeFinishStream(record);
        return;
      }
      case 'RST': {
        const record = this.streams.get(frame.streamId);
        if (!record) {
          // Either it raced our own RST, or it is for a stream we never opened.
          if (frame.streamId > this.highestStreamId) {
            this.fatal(ErrorCode.PROTOCOL_ERROR, `RST for stream ${frame.streamId}, which was never opened`);
          }
          return;
        }
        const code = normalizeResetCode(frame.code);
        this.failStream(record, new StreamResetError(code, 'reset by peer', true));
        return;
      }
      case 'WINDOW': {
        const record = this.lookup(frame.streamId);
        if (!record) return;
        record.sendWindow += frame.increment;
        if (record.sendWindow > MAX_WINDOW) {
          this.resetStream(record, ErrorCode.PROTOCOL_ERROR, 'send window overflow');
          return;
        }
        this.markReady(record);
        this.pump();
        return;
      }
      case 'PING':
        this.queueControl({ type: 'PONG', streamId: 0, nonce: frame.nonce });
        return;
      case 'PONG': {
        const pending = this.pendingPings.get(frame.nonce.toString());
        if (!pending) return; // a nonce we never sent, or a late answer
        this.pendingPings.delete(frame.nonce.toString());
        pending.resolve(Date.now() - pending.sentAt);
        return;
      }
      case 'GOAWAY':
        this.goAwayReceived = true;
        this.emit('goaway', { code: frame.code, reason: frame.reason } satisfies GoAwayInfo);
        return;
      case 'PROBE':
        if (this.role !== 'server') {
          this.fatal(ErrorCode.PROTOCOL_ERROR, 'PROBE received by a client session');
          return;
        }
        this.answerProbe(frame.streamId, frame.request);
        return;
      case 'PROBE_RESULT': {
        if (this.role !== 'client') {
          this.fatal(ErrorCode.PROTOCOL_ERROR, 'PROBE_RESULT received by a server session');
          return;
        }
        const pending = this.pendingProbes.get(frame.streamId);
        if (!pending) return; // timed out already, or never asked
        this.pendingProbes.delete(frame.streamId);
        clearTimeout(pending.timer);
        pending.resolve(frame.result);
        return;
      }
      default:
        this.fatal(ErrorCode.PROTOCOL_ERROR, 'unknown frame');
    }
  }

  private handleOpen(frame: Extract<Frame, { type: 'OPEN' }>): void {
    if (this.role !== 'server') {
      // Only servers open streams, so a client is the one that receives OPEN.
      if (frame.streamId <= this.highestStreamId) {
        this.fatal(ErrorCode.PROTOCOL_ERROR, `OPEN reuses stream id ${frame.streamId}`);
        return;
      }
      this.highestStreamId = frame.streamId;
      if (this.goAwaySent || this.streams.size >= MAX_CONCURRENT_STREAMS) {
        this.queueControl({ type: 'RST', streamId: frame.streamId, code: ErrorCode.REFUSED });
        return;
      }
      const record = this.createRecord(frame.streamId, frame);
      this.emit('stream', record.stream);
      return;
    }
    this.fatal(ErrorCode.PROTOCOL_ERROR, 'OPEN received by a server session');
  }

  private answerProbe(probeId: number, request: ProbeRequest): void {
    const startedAt = Date.now();
    const reply = (result: ProbeResult): void => {
      if (this.isClosed) return;
      this.queueControl({ type: 'PROBE_RESULT', streamId: probeId, result });
    };
    const handler = this.onProbe;
    if (!handler) {
      reply({ error: 'UNSUPPORTED', elapsedMs: 0 });
      return;
    }
    void Promise.resolve()
      .then(() => handler(request))
      .then(reply)
      .catch(() => reply({ error: 'PROBE_FAILED', elapsedMs: Date.now() - startedAt }));
  }

  /**
   * A frame for a stream we don't have is either a race with our own RST (fine,
   * ignore it) or a stream that never existed (fatal).
   */
  private lookup(streamId: number): StreamRecord | undefined {
    const record = this.streams.get(streamId);
    if (record) return record;
    if (streamId > this.highestStreamId) {
      this.fatal(ErrorCode.PROTOCOL_ERROR, `frame for stream ${streamId}, which was never opened`);
    }
    return undefined;
  }

  // ── stream bookkeeping ─────────────────────────────────────────────────────

  private createRecord(streamId: number, open: Extract<Frame, { type: 'OPEN' }>): StreamRecord {
    const stream = new TunnelStream({ id: streamId, metadata: open.metadata, host: this });
    // See failStream: the session owns an error sink so a teardown can never
    // throw out of a stream nobody is listening to.
    stream.on('error', () => undefined);
    const record: StreamRecord = {
      stream,
      sendWindow: INITIAL_WINDOW,
      receiveAllowance: INITIAL_WINDOW,
      unannounced: 0,
      queue: [],
      finalPending: false,
      finalCb: undefined,
      endSent: false,
      endReceived: false,
      suppressReset: false,
      queued: false,
    };
    this.streams.set(streamId, record);
    return record;
  }

  /**
   * Destroy a stream the session is tearing down, reporting why.
   *
   * Safe to always pass the error because createRecord attaches a session-owned
   * 'error' sink: without one, a stream teardown (a dropped tunnel — a routine
   * event) would throw out of an EventEmitter and take the process with it, and
   * node's own pipe() re-emits on a destination that has no other listener.
   * A consumer's own 'error' listener still gets the error; one that only
   * listens for 'close' simply doesn't.
   */
  private failStream(record: StreamRecord, err: Error): void {
    record.suppressReset = true;
    record.stream.destroy(err);
  }

  /** Release the callbacks a torn-down stream still holds. See streamDestroy. */
  private settleJobs(record: StreamRecord): void {
    for (const job of record.queue) job.cb(null);
    record.queue.length = 0;
    const cb = record.finalCb;
    record.finalCb = undefined;
    cb?.(null);
  }

  /** A violation that belongs to one stream, not to the session. */
  private resetStream(record: StreamRecord, code: number, detail: string): void {
    this.queueControl({ type: 'RST', streamId: record.stream.id, code });
    this.streams.delete(record.stream.id);
    this.failStream(record, new StreamResetError(code, detail, false));
    this.afterStreamClosed();
  }

  /**
   * Both ENDs exchanged: the stream is done as far as the protocol is concerned,
   * so it stops counting against the cap and stops holding up a drain. The
   * Duplex itself stays alive until the application has read what it buffered.
   */
  private maybeFinishStream(record: StreamRecord): void {
    if (!record.endSent || !record.endReceived) return;
    if (!this.streams.has(record.stream.id)) return;
    this.streams.delete(record.stream.id);
    this.afterStreamClosed();
  }

  private afterStreamClosed(): void {
    if (this.drainStarted && this.streams.size === 0 && !this.isClosed) this.endDrain(false);
  }

  private endDrain(timedOut: boolean): void {
    if (this.isClosed) return;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    if (timedOut && this.streams.size > 0) {
      for (const record of [...this.streams.values()]) {
        this.streams.delete(record.stream.id);
        this.queueControl({ type: 'RST', streamId: record.stream.id, code: ErrorCode.GOING_AWAY });
        this.failStream(record, new StreamResetError(ErrorCode.GOING_AWAY, 'drain deadline passed', false));
      }
      this.closeTransport(CloseCode.GOING_AWAY, 'drain deadline passed');
      return;
    }
    this.closeTransport(CloseCode.NORMAL, '');
  }

  // ── outbound ───────────────────────────────────────────────────────────────

  private queueControl(frame: Frame): void {
    if (this.isClosed) return;
    this.control.push(Buffer.from(encodeFrame(frame)));
    this.pump();
  }

  /** Bypasses the queue for a frame that has to go out before the socket closes. */
  private sendImmediate(frame: Frame): void {
    if (this.isClosed) return;
    try {
      this.transport.send(Buffer.from(encodeFrame(frame)), () => undefined);
    } catch {
      /* the socket is already gone; the close below is what matters */
    }
  }

  private markReady(record: StreamRecord): void {
    if (record.queued) return;
    if (!this.streams.has(record.stream.id)) return;
    if (!this.hasWork(record)) return;
    record.queued = true;
    this.ready.push(record.stream.id);
  }

  private hasWork(record: StreamRecord): boolean {
    if (record.queue.length > 0) return record.sendWindow > 0;
    return record.finalPending && !record.endSent;
  }

  /**
   * One writer for the whole session. Control frames first, then one DATA frame
   * per ready stream in round-robin order — which is what keeps a 10 MB download
   * from delaying a 1 KB request by more than a single frame.
   */
  private pump(): void {
    if (this.pumping || this.isClosed) return;
    this.pumping = true;
    try {
      while (!this.isClosed && this.unackedBytes < MAX_UNACKED_SEND_BYTES) {
        const control = this.control.shift();
        if (control) {
          this.writeBytes(control);
          continue;
        }
        const record = this.nextReady();
        if (!record) break;
        this.writeStreamFrame(record);
      }
    } finally {
      this.pumping = false;
    }
  }

  private nextReady(): StreamRecord | undefined {
    while (this.ready.length > 0) {
      const streamId = this.ready.shift();
      if (streamId === undefined) return undefined;
      const record = this.streams.get(streamId);
      if (!record) continue;
      record.queued = false;
      if (this.hasWork(record)) return record;
    }
    return undefined;
  }

  private writeStreamFrame(record: StreamRecord): void {
    const job = record.queue[0];
    if (job) {
      const size = Math.min(MAX_DATA_PAYLOAD, record.sendWindow, job.chunk.length - job.offset);
      const slice = job.chunk.subarray(job.offset, job.offset + size);
      job.offset += size;
      record.sendWindow -= size;
      this.writeBytes(Buffer.from(encodeFrame({ type: 'DATA', streamId: record.stream.id, data: slice })));
      if (job.offset >= job.chunk.length) {
        record.queue.shift();
        job.cb(null);
      }
    } else if (record.finalPending && !record.endSent) {
      record.endSent = true;
      this.writeBytes(Buffer.from(encodeFrame({ type: 'END', streamId: record.stream.id })));
      const cb = record.finalCb;
      record.finalCb = undefined;
      cb?.(null);
      this.maybeFinishStream(record);
    }
    // Back of the ring, so every other ready stream gets a turn first.
    this.markReady(record);
  }

  private writeBytes(bytes: Buffer): void {
    this.unackedBytes += bytes.length;
    this.transport.send(bytes, (err) => {
      this.unackedBytes -= bytes.length;
      if (err) {
        this.finish(CloseCode.ABNORMAL, err.message, false);
        return;
      }
      this.pump();
    });
  }

  // ── liveness and teardown ──────────────────────────────────────────────────

  private armDeadPeerTimer(): void {
    if (this.isClosed) return;
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = unref(
      setTimeout(() => {
        // A peer that has said nothing for a minute cannot complete a close
        // handshake, so there is nothing to wait for.
        this.transport.terminate();
        this.finish(CloseCode.TIMEOUT, 'peer went silent', false);
      }, this.deadPeerTimeoutMs),
    );
  }

  private fatal(code: number, detail: string): void {
    if (this.isClosed) return;
    this.sendImmediate({ type: 'GOAWAY', streamId: 0, code, reason: truncateReason(detail) });
    this.closeTransport(CLOSE_CODE_BASE + code, detail);
  }

  private closeTransport(closeCode: number, reason: string): void {
    if (this.isClosed) return;
    try {
      this.transport.close(closeCode, reason);
    } catch {
      /* already gone */
    }
    this.finish(closeCode, reason, false);
  }

  private finish(closeCode: number, reason: string, remote: boolean): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeCode = closeCode;

    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.pingTimer = undefined;
    this.deadTimer = undefined;
    this.drainTimer = undefined;

    const err = new SessionClosedError(closeCode, reason);
    for (const record of [...this.streams.values()]) {
      this.streams.delete(record.stream.id);
      this.settleJobs(record);
      this.failStream(record, err);
    }
    this.ready.length = 0;
    this.control.length = 0;

    for (const pending of this.pendingPings.values()) pending.reject(err);
    this.pendingPings.clear();
    for (const probe of this.pendingProbes.values()) {
      clearTimeout(probe.timer);
      probe.resolve({ error: 'CLOSED', elapsedMs: Date.now() - probe.startedAt });
    }
    this.pendingProbes.clear();

    for (const resolve of this.goAwayWaiters) resolve();
    this.goAwayWaiters.length = 0;

    this.emit('close', { closeCode, reason, remote } satisfies SessionCloseInfo);
  }
}
