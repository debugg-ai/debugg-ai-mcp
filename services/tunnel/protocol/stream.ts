/**
 * Debugg tunnel wire protocol v1 — one multiplexed stream as a node Duplex.
 *
 * A TunnelStream is the byte pipe for exactly one inbound browser connection.
 * Both ends pipe it straight at a socket, so being a real Duplex (and honouring
 * backpressure in both directions) is the whole point:
 *
 *   server:  socket.pipe(stream).pipe(socket)
 *   client:  stream.pipe(net.connect(caddyLoopbackPort)).pipe(stream)
 *
 * Writes become DATA frames of at most MAX_DATA_PAYLOAD, gated by the stream's
 * remaining credit. end() sends END. destroy() sends RST.
 *
 * All protocol state lives in the session; this class only forwards. The one
 * piece of cleverness is the read() override, which is how the session learns
 * how many bytes the application has actually consumed and therefore how much
 * credit it may give back.
 */

import { Duplex } from 'node:stream';
import type { OpenMetadata } from './codec.js';
import { ErrorCode, MAX_DATA_PAYLOAD } from './constants.js';

/** The session side of a stream. Internal: consumers never implement this. */
export interface StreamHost {
  streamWrite(stream: TunnelStream, chunk: Buffer, cb: (err?: Error | null) => void): void;
  streamFinal(stream: TunnelStream, cb: (err?: Error | null) => void): void;
  streamDestroy(stream: TunnelStream, err: Error | null, resetCode: number | undefined): void;
  streamConsumed(stream: TunnelStream, bytes: number): void;
}

export interface TunnelStreamOptions {
  id: number;
  metadata: OpenMetadata;
  host: StreamHost;
}

export class TunnelStream extends Duplex {
  /** The stream id the server allocated. */
  readonly id: number;

  /**
   * Whitelisted OPEN metadata. Informational only — NEVER a dial target
   * (see the SSRF note on bead debugg_ai_mcp-xkoh.1.2).
   */
  readonly metadata: OpenMetadata;

  private readonly host: StreamHost;
  private pendingResetCode: number | undefined;
  private pushedTotal = 0;
  private reportedConsumed = 0;

  constructor(options: TunnelStreamOptions) {
    super({
      // One frame's worth of writable buffer: enough to keep the wire busy,
      // little enough that a piped producer is held back rather than drained.
      writableHighWaterMark: MAX_DATA_PAYLOAD,
      readableHighWaterMark: MAX_DATA_PAYLOAD,
      allowHalfOpen: true,
    });
    this.id = options.id;
    this.metadata = options.metadata;
    this.host = options.host;
  }

  /**
   * Abort both directions with RST(code). Defaults to ErrorCode.RESET. Use
   * ErrorCode.UPSTREAM_UNREACHABLE when the local target could not be dialled,
   * so the server can render DEBUGG_TUNNEL_UPSTREAM_REFUSED.
   *
   * Deliberately does not raise a local 'error': the side that chose to reset
   * already knows, and an unhandled 'error' on a Duplex throws.
   */
  reset(code: number = ErrorCode.RESET): void {
    this.pendingResetCode = code;
    this.destroy();
  }

  /**
   * Hand the session's inbound bytes to the readable side.
   *
   * Never call push() directly: in flowing mode node delivers a pushed chunk
   * straight to the 'data' listener without it ever entering the buffer or going
   * through read(), so consumption has to be reconciled right here. Missing it
   * means credit is never returned and a transfer larger than one window
   * deadlocks — which is exactly what it did.
   */
  deliver(chunk: Uint8Array): boolean {
    this.pushedTotal += chunk.length;
    const accepted = this.push(chunk);
    this.syncConsumed();
    return accepted;
  }

  /** The peer half-closed: no more inbound bytes on this stream. */
  deliverEnd(): void {
    this.push(null);
  }

  /**
   * Bytes that have left the readable buffer are bytes the application consumed,
   * and those are what the session may grant back as WINDOW. Credit is never
   * given for bytes still sitting in the buffer.
   */
  private syncConsumed(): void {
    const consumed = this.pushedTotal - this.readableLength;
    const delta = consumed - this.reportedConsumed;
    if (delta <= 0) return;
    this.reportedConsumed = consumed;
    this.host.streamConsumed(this, delta);
  }

  override read(size?: number): any {
    const chunk = super.read(size) as Buffer | string | null;
    this.syncConsumed();
    return chunk;
  }

  override _read(): void {
    // Nothing to pull: the session pushes as DATA frames arrive, and flow
    // control — not this callback — is what limits how much can be in flight.
  }

  override _write(chunk: unknown, encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, encoding);
    this.host.streamWrite(this, buf, cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.host.streamFinal(this, cb);
  }

  override _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    this.host.streamDestroy(this, err, this.pendingResetCode);
    cb(err);
  }
}
