/**
 * Test support for the debugg tunnel wire protocol (bead debugg_ai_mcp-xkoh.1.3).
 *
 * Everything here is deliberately INDEPENDENT of services/tunnel/protocol/codec.ts:
 * frames are built and parsed with plain Buffer arithmetic straight from the spec
 * on bead debugg_ai_mcp-xkoh.1.2. That way a session test that fails tells you the
 * session is wrong, not that the codec is, and the hand-rolled builder doubles as
 * a second opinion on the codec itself.
 *
 * Not a test file: jest's testRegex only picks up *.test.ts (and __tests__/x/test.ts).
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FrameTransport, TransportHandlers } from '../../../../services/tunnel/protocol/transport.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VECTOR_DIR = path.resolve(HERE, '../../../../services/tunnel/protocol/vectors');

// ── conformance vector files ─────────────────────────────────────────────────

/** Bytes in a vector: either a full hex string, or a prefix + fill (+ suffix). */
export interface VectorBytes {
  hex?: string;
  hexPrefix?: string;
  fill?: { byte: string; count: number };
  hexSuffix?: string;
}

export interface FrameVector extends VectorBytes {
  name: string;
  frame: Record<string, unknown>;
  decodeOnly?: boolean;
  note?: string;
}

export interface InvalidVector extends VectorBytes {
  name: string;
  error: string;
  why?: string;
}

export interface HandshakeVector {
  name: string;
  requestHeaders: Record<string, string | string[] | undefined>;
  expect: Record<string, unknown>;
}

export function loadVectorFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, file), 'utf8')) as T;
}

/** Turn a vector's byte description into the actual message bytes. */
export function materializeBytes(v: VectorBytes): Buffer {
  if (typeof v.hex === 'string') return Buffer.from(v.hex, 'hex');
  const parts: Buffer[] = [];
  if (v.hexPrefix) parts.push(Buffer.from(v.hexPrefix, 'hex'));
  if (v.fill) parts.push(Buffer.alloc(v.fill.count, Buffer.from(v.fill.byte, 'hex')[0]));
  if (v.hexSuffix) parts.push(Buffer.from(v.hexSuffix, 'hex'));
  return Buffer.concat(parts);
}

// ── raw frames, built and parsed by hand ─────────────────────────────────────

export const RawType = {
  OPEN: 0x01,
  DATA: 0x02,
  END: 0x03,
  RST: 0x04,
  WINDOW: 0x05,
  PING: 0x06,
  PONG: 0x07,
  GOAWAY: 0x08,
  PROBE: 0x09,
  PROBE_RESULT: 0x0a,
} as const;

export const RawTypeName: Record<number, string> = Object.fromEntries(
  Object.entries(RawType).map(([name, code]) => [code, name]),
);

export function rawFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId >>> 0, 1);
  return Buffer.concat([header, payload]);
}

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const u64 = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n, 0);
  return b;
};

export const raw = {
  open(streamId: number, metadata: Record<string, unknown> = { kind: 'http' }): Buffer {
    return rawFrame(RawType.OPEN, streamId, Buffer.from(JSON.stringify(metadata), 'utf8'));
  },
  data(streamId: number, payload: Buffer | string): Buffer {
    return rawFrame(RawType.DATA, streamId, typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload);
  },
  end(streamId: number): Buffer {
    return rawFrame(RawType.END, streamId);
  },
  rst(streamId: number, code: number): Buffer {
    return rawFrame(RawType.RST, streamId, u16(code));
  },
  window(streamId: number, increment: number): Buffer {
    return rawFrame(RawType.WINDOW, streamId, u32(increment));
  },
  ping(nonce: bigint): Buffer {
    return rawFrame(RawType.PING, 0, u64(nonce));
  },
  pong(nonce: bigint): Buffer {
    return rawFrame(RawType.PONG, 0, u64(nonce));
  },
  goaway(code: number, reason = ''): Buffer {
    return rawFrame(RawType.GOAWAY, 0, Buffer.concat([u16(code), Buffer.from(reason, 'utf8')]));
  },
  probe(probeId: number, probePath: string): Buffer {
    return rawFrame(RawType.PROBE, probeId, Buffer.from(JSON.stringify({ path: probePath }), 'utf8'));
  },
  probeResult(probeId: number, result: Record<string, unknown>): Buffer {
    return rawFrame(RawType.PROBE_RESULT, probeId, Buffer.from(JSON.stringify(result), 'utf8'));
  },
};

export interface ParsedFrame {
  type: number;
  typeName: string;
  streamId: number;
  payload: Buffer;
  /** JSON payloads (OPEN / PROBE / PROBE_RESULT). */
  json?: Record<string, unknown>;
  /** RST / GOAWAY. */
  code?: number;
  /** WINDOW. */
  increment?: number;
  /** PING / PONG. */
  nonce?: bigint;
  /** GOAWAY. */
  reason?: string;
}

export function parseRaw(bytes: Uint8Array): ParsedFrame {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = buf.readUInt8(0);
  const streamId = buf.readUInt32BE(1);
  const payload = Buffer.from(buf.subarray(5));
  const parsed: ParsedFrame = { type, typeName: RawTypeName[type] ?? `0x${type.toString(16)}`, streamId, payload };
  switch (type) {
    case RawType.OPEN:
    case RawType.PROBE:
    case RawType.PROBE_RESULT:
      parsed.json = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      break;
    case RawType.RST:
      parsed.code = payload.readUInt16BE(0);
      break;
    case RawType.WINDOW:
      parsed.increment = payload.readUInt32BE(0);
      break;
    case RawType.PING:
    case RawType.PONG:
      parsed.nonce = payload.readBigUInt64BE(0);
      break;
    case RawType.GOAWAY:
      parsed.code = payload.readUInt16BE(0);
      parsed.reason = payload.subarray(2).toString('utf8');
      break;
    default:
      break;
  }
  return parsed;
}

// ── transports ───────────────────────────────────────────────────────────────

export interface FakeTransportOptions {
  /**
   * When false the send callbacks queue up in `acks` until flushAcks() runs, so a
   * test can hold the socket "full" and watch what the session does about it.
   */
  autoAck?: boolean;
}

/** A FrameTransport a test drives directly, frame by frame. */
export class FakeTransport implements FrameTransport {
  readonly sent: Buffer[] = [];
  readonly acks: Array<(err?: Error | null) => void> = [];
  handlers: TransportHandlers | undefined;
  closedWith: { code: number; reason: string } | undefined;
  terminated = false;
  private readonly autoAck: boolean;

  constructor(options: FakeTransportOptions = {}) {
    this.autoAck = options.autoAck !== false;
  }

  send(frame: Uint8Array, cb: (err?: Error | null) => void): void {
    this.sent.push(Buffer.from(frame));
    if (this.autoAck) setImmediate(() => cb(null));
    else this.acks.push(cb);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  // ── test-side driving ──

  /** Run queued send callbacks (only meaningful with autoAck: false). */
  flushAcks(count = this.acks.length): void {
    for (let i = 0; i < count && this.acks.length > 0; i++) {
      const cb = this.acks.shift();
      cb?.(null);
    }
  }

  deliver(...frames: Uint8Array[]): void {
    for (const f of frames) this.handlers!.onFrame(f);
  }

  deliverInvalid(detail = 'text message'): void {
    this.handlers!.onInvalidMessage(detail);
  }

  deliverClose(code: number, reason = ''): void {
    this.handlers!.onClose(code, reason);
  }

  /** Everything the session has handed us, parsed. */
  frames(): ParsedFrame[] {
    return this.sent.map(parseRaw);
  }

  framesOfType(type: number): ParsedFrame[] {
    return this.frames().filter((f) => f.type === type);
  }

  bytesSentOfType(type: number): number {
    return this.framesOfType(type).reduce((n, f) => n + f.payload.length, 0);
  }
}

/**
 * Two transports wired to each other, so two real sessions can talk over an
 * in-memory "socket" with IO-like (setImmediate) ordering.
 */
export class MemoryTransport extends FakeTransport {
  peer: MemoryTransport | undefined;

  override send(frame: Uint8Array, cb: (err?: Error | null) => void): void {
    this.sent.push(Buffer.from(frame));
    const copy = Buffer.from(frame);
    setImmediate(() => {
      this.peer?.handlers?.onFrame(copy);
      cb(null);
    });
  }

  override close(code: number, reason: string): void {
    super.close(code, reason);
    setImmediate(() => this.peer?.handlers?.onClose(code, reason));
  }

  override terminate(): void {
    super.terminate();
    setImmediate(() => this.peer?.handlers?.onClose(1006, ''));
  }
}

export function memoryPair(): { client: MemoryTransport; server: MemoryTransport } {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

// ── misc ─────────────────────────────────────────────────────────────────────

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a condition on real timers. Never use this under fake timers. */
export async function waitFor(
  condition: () => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${opts.label ?? 'condition'}`);
    await tick(2);
  }
}

export function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
export function seededBytes(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}
