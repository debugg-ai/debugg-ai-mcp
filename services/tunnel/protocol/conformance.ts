/**
 * Debugg tunnel wire protocol v1 — the conformance runner.
 *
 * The vectors in ./vectors are the specification. This runner is what makes them
 * enforceable in a repo that is NOT this one: the tunnel server vendors this
 * whole directory (bead debugg_ai_mcp-xkoh.1.6 §D/§G) and its CI calls
 * runConformanceVectors on the copy. Without a checker inside the vendored unit,
 * the server would have to hand-copy test files from __tests__, which is drift
 * on day one — in the very mechanism meant to prevent drift.
 *
 * Deliberately dependency free and IO free: the CALLER reads the three JSON
 * files and passes them in, so this works under any test runner, bundler or
 * runtime. It returns failures instead of throwing, so each caller can report
 * them its own way.
 */

import { decodeFrame, encodeFrame, type Frame } from './codec.js';
import { ProtocolError } from './errors.js';
import { validateHandshakeRequest } from './handshake.js';
import { ErrorCode } from './constants.js';

export interface ConformanceFailure {
  /** Which vector file the failure came from. */
  file: string;
  /** The vector's `name`. */
  vector: string;
  detail: string;
}

export interface ConformanceInput {
  /** Parsed vectors/frames.json */
  frames: unknown;
  /** Parsed vectors/invalid-frames.json */
  invalidFrames: unknown;
  /** Parsed vectors/handshake.json */
  handshake: unknown;
}

interface VectorBytes {
  hex?: string;
  hexPrefix?: string;
  fill?: { byte: string; count: number };
  hexSuffix?: string;
}

type Json = any;

function materialize(vector: VectorBytes): Buffer {
  if (typeof vector.hex === 'string') return Buffer.from(vector.hex, 'hex');
  const parts: Buffer[] = [];
  if (vector.hexPrefix) parts.push(Buffer.from(vector.hexPrefix, 'hex'));
  if (vector.fill) parts.push(Buffer.alloc(vector.fill.count, Buffer.from(vector.fill.byte, 'hex')[0]));
  if (vector.hexSuffix) parts.push(Buffer.from(vector.hexSuffix, 'hex'));
  return Buffer.concat(parts);
}

/** Vector JSON -> the Frame the codec works with. */
function frameFromVector(v: Json): Frame {
  switch (v.type) {
    case 'OPEN':
      return { type: 'OPEN', streamId: v.streamId, metadata: v.metadata };
    case 'DATA':
      return {
        type: 'DATA',
        streamId: v.streamId,
        data: v.dataFill
          ? Buffer.alloc(v.dataFill.count, Buffer.from(v.dataFill.byte, 'hex')[0])
          : Buffer.from(v.dataHex, 'hex'),
      };
    case 'END':
      return { type: 'END', streamId: v.streamId };
    case 'RST':
      return { type: 'RST', streamId: v.streamId, code: v.code };
    case 'WINDOW':
      return { type: 'WINDOW', streamId: v.streamId, increment: v.increment };
    case 'PING':
      return { type: 'PING', streamId: 0, nonce: BigInt(v.nonce) };
    case 'PONG':
      return { type: 'PONG', streamId: 0, nonce: BigInt(v.nonce) };
    case 'GOAWAY':
      return { type: 'GOAWAY', streamId: 0, code: v.code, reason: v.reason };
    case 'PROBE':
      return { type: 'PROBE', streamId: v.streamId, request: v.request };
    case 'PROBE_RESULT':
      return { type: 'PROBE_RESULT', streamId: v.streamId, result: v.result };
    default:
      throw new Error(`unknown vector frame type ${String(v.type)}`);
  }
}

/** A Frame -> plain JSON, so a decoded frame can be compared with a vector. */
function frameToComparable(frame: Frame): Json {
  if (frame.type === 'DATA') {
    return { type: 'DATA', streamId: frame.streamId, dataHex: Buffer.from(frame.data).toString('hex') };
  }
  if (frame.type === 'PING' || frame.type === 'PONG') {
    return { type: frame.type, streamId: 0, nonce: frame.nonce.toString() };
  }
  return { ...frame };
}

function vectorToComparable(v: Json): Json {
  if (v.type === 'DATA' && v.dataFill) {
    return {
      type: 'DATA',
      streamId: v.streamId,
      dataHex: Buffer.alloc(v.dataFill.count, Buffer.from(v.dataFill.byte, 'hex')[0]).toString('hex'),
    };
  }
  return { ...v };
}

/** Structural equality, ignoring key order and undefined-valued keys. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

function describe(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

/**
 * Run every vector against this build of the codec and the handshake.
 * An empty result means this copy of the module is on-spec.
 */
export function runConformanceVectors(vectors: ConformanceInput): ConformanceFailure[] {
  const failures: ConformanceFailure[] = [];
  const fail = (file: string, vector: string, detail: string): void => {
    failures.push({ file, vector, detail });
  };

  for (const vector of ((vectors.frames as Json)?.vectors ?? []) as Json[]) {
    const expectedBytes = materialize(vector);
    if (!vector.decodeOnly) {
      try {
        const encoded = Buffer.from(encodeFrame(frameFromVector(vector.frame)));
        if (!encoded.equals(expectedBytes)) {
          fail(
            'frames.json',
            vector.name,
            `encoded ${encoded.length} bytes that do not match the vector (got ${encoded
              .subarray(0, 32)
              .toString('hex')}..., want ${expectedBytes.subarray(0, 32).toString('hex')}...)`,
          );
        }
      } catch (err) {
        fail('frames.json', vector.name, `encode threw: ${(err as Error).message}`);
      }
    }
    try {
      const decoded = frameToComparable(decodeFrame(expectedBytes));
      const expected = vectorToComparable(vector.frame);
      if (!deepEqual(decoded, expected)) {
        fail('frames.json', vector.name, `decoded ${describe(decoded)}, want ${describe(expected)}`);
      }
    } catch (err) {
      fail('frames.json', vector.name, `decode threw: ${(err as Error).message}`);
    }
  }

  for (const vector of ((vectors.invalidFrames as Json)?.vectors ?? []) as Json[]) {
    try {
      decodeFrame(materialize(vector));
      fail('invalid-frames.json', vector.name, 'decoded successfully; it must raise PROTOCOL_ERROR');
    } catch (err) {
      if (!(err instanceof ProtocolError) || err.code !== ErrorCode.PROTOCOL_ERROR) {
        fail('invalid-frames.json', vector.name, `raised ${(err as Error).name}, want ProtocolError`);
      }
    }
  }

  const handshakeDoc = vectors.handshake as Json;
  for (const vector of (handshakeDoc?.vectors ?? []) as Json[]) {
    try {
      const result = validateHandshakeRequest(vector.requestHeaders, handshakeDoc.supported);
      if (!deepEqual(result, vector.expect)) {
        fail('handshake.json', vector.name, `returned ${describe(result)}, want ${describe(vector.expect)}`);
      }
    } catch (err) {
      fail('handshake.json', vector.name, `threw: ${(err as Error).message}`);
    }
  }

  return failures;
}
