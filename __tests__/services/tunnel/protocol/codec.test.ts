/**
 * Frame codec — debugg tunnel wire protocol v1.
 * Bead debugg_ai_mcp-xkoh.1.3 (2.1). Spec: bead debugg_ai_mcp-xkoh.1.2.
 *
 * The conformance vectors are the contract any second implementation (or
 * vendored copy) of this module has to satisfy, so they are checked
 * byte-for-byte in both directions here.
 */

import {
  encodeFrame,
  decodeFrame,
  type Frame,
  type OpenMetadata,
  type ProbeRequest,
  type ProbeResult,
} from '../../../../services/tunnel/protocol/codec.js';
import { ProtocolError } from '../../../../services/tunnel/protocol/errors.js';
import { runConformanceVectors } from '../../../../services/tunnel/protocol/conformance.js';
import { ErrorCode, MAX_DATA_PAYLOAD } from '../../../../services/tunnel/protocol/constants.js';
import {
  loadVectorFile,
  materializeBytes,
  type FrameVector,
  type InvalidVector,
} from './helpers.js';

interface FrameVectorFile {
  protocolVersion: number;
  vectors: FrameVector[];
}
interface InvalidVectorFile {
  vectors: InvalidVector[];
}

const frameVectors = loadVectorFile<FrameVectorFile>('frames.json');
const invalidVectors = loadVectorFile<InvalidVectorFile>('invalid-frames.json');

/** Vector JSON -> the Frame the codec works with. */
function frameFromVector(v: Record<string, any>): Frame {
  switch (v.type) {
    case 'OPEN':
      return { type: 'OPEN', streamId: v.streamId, metadata: v.metadata as OpenMetadata };
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
      return { type: 'PROBE', streamId: v.streamId, request: v.request as ProbeRequest };
    case 'PROBE_RESULT':
      return { type: 'PROBE_RESULT', streamId: v.streamId, result: v.result as ProbeResult };
    default:
      throw new Error(`unknown vector frame type ${v.type}`);
  }
}

/** A Frame -> plain JSON, so decoded frames can be compared against the vectors. */
function frameToComparable(frame: Frame): Record<string, unknown> {
  if (frame.type === 'DATA') {
    return { type: 'DATA', streamId: frame.streamId, dataHex: Buffer.from(frame.data).toString('hex') };
  }
  if (frame.type === 'PING' || frame.type === 'PONG') {
    return { type: frame.type, streamId: 0, nonce: frame.nonce.toString() };
  }
  return { ...frame } as unknown as Record<string, unknown>;
}

function vectorToComparable(v: Record<string, any>): Record<string, unknown> {
  if (v.type === 'DATA' && v.dataFill) {
    return {
      type: 'DATA',
      streamId: v.streamId,
      dataHex: Buffer.alloc(v.dataFill.count, Buffer.from(v.dataFill.byte, 'hex')[0]).toString('hex'),
    };
  }
  return { ...v };
}

describe('codec — conformance vectors', () => {
  it('has vectors for every frame type', () => {
    const types = new Set(frameVectors.vectors.map((v) => (v.frame as Record<string, unknown>).type));
    expect([...types].sort()).toEqual(
      ['DATA', 'END', 'GOAWAY', 'OPEN', 'PING', 'PONG', 'PROBE', 'PROBE_RESULT', 'RST', 'WINDOW'].sort(),
    );
  });

  it.each(frameVectors.vectors.filter((v) => !v.decodeOnly))('encodes $name byte for byte', (v) => {
    const encoded = encodeFrame(frameFromVector(v.frame as Record<string, any>));
    expect(Buffer.from(encoded).toString('hex')).toBe(materializeBytes(v).toString('hex'));
  });

  it.each(frameVectors.vectors)('decodes $name', (v) => {
    const decoded = decodeFrame(materializeBytes(v));
    expect(frameToComparable(decoded)).toEqual(vectorToComparable(v.frame as Record<string, any>));
  });

  it.each(invalidVectors.vectors)('rejects $name with PROTOCOL_ERROR', (v) => {
    const bytes = materializeBytes(v);
    expect(() => decodeFrame(bytes)).toThrow(ProtocolError);
    try {
      decodeFrame(bytes);
    } catch (err) {
      expect((err as ProtocolError).code).toBe(ErrorCode.PROTOCOL_ERROR);
    }
  });
});

describe('conformance runner — the checker the vendored copy carries', () => {
  // The tunnel server's CI calls exactly this function on its vendored copy
  // (bead debugg_ai_mcp-xkoh.1.6 section G), so it has to pass here first.
  it('reports no failures for this build', () => {
    expect(
      runConformanceVectors({
        frames: frameVectors,
        invalidFrames: invalidVectors,
        handshake: loadVectorFile('handshake.json'),
      }),
    ).toEqual([]);
  });

  it('catches a copy that has drifted', () => {
    const tampered = {
      vectors: [{ name: 'tampered OPEN', frame: { type: 'OPEN', streamId: 1, metadata: {} }, hex: '01000000ff7b7d' }],
    };
    const failures = runConformanceVectors({
      frames: tampered,
      invalidFrames: { vectors: [] },
      handshake: { supported: [1], vectors: [] },
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ file: 'frames.json', vector: 'tampered OPEN' });
  });
});

describe('codec — round trips', () => {
  const samples: Array<{ name: string; frame: Frame }> = [
    { name: 'OPEN', frame: { type: 'OPEN', streamId: 1, metadata: { kind: 'http', requestId: 'r1' } } },
    { name: 'OPEN with empty metadata', frame: { type: 'OPEN', streamId: 2, metadata: {} } },
    { name: 'DATA one byte', frame: { type: 'DATA', streamId: 1, data: Uint8Array.from([0x00]) } },
    {
      name: 'DATA at the payload limit',
      frame: { type: 'DATA', streamId: 1, data: new Uint8Array(MAX_DATA_PAYLOAD).fill(0x5a) },
    },
    { name: 'END', frame: { type: 'END', streamId: 0xffffffff } },
    { name: 'RST', frame: { type: 'RST', streamId: 3, code: ErrorCode.UPSTREAM_UNREACHABLE } },
    { name: 'WINDOW', frame: { type: 'WINDOW', streamId: 3, increment: 2147483647 } },
    { name: 'PING', frame: { type: 'PING', streamId: 0, nonce: 18446744073709551615n } },
    { name: 'PONG', frame: { type: 'PONG', streamId: 0, nonce: 0n } },
    { name: 'GOAWAY with a unicode reason', frame: { type: 'GOAWAY', streamId: 0, code: ErrorCode.GOING_AWAY, reason: 'déploiement 🚀' } },
    { name: 'GOAWAY without a reason', frame: { type: 'GOAWAY', streamId: 0, code: ErrorCode.REVOKED, reason: '' } },
    { name: 'PROBE', frame: { type: 'PROBE', streamId: 9, request: { path: '/health' } } },
    {
      name: 'PROBE_RESULT',
      frame: { type: 'PROBE_RESULT', streamId: 9, result: { status: 200, marker: undefined, elapsedMs: 7 } },
    },
  ];

  it.each(samples)('round trips $name', ({ frame }) => {
    const decoded = decodeFrame(encodeFrame(frame));
    expect(frameToComparable(decoded)).toEqual(frameToComparable(frame));
  });

  it('decodes a frame that sits at a non-zero byteOffset (ws hands out pooled buffers)', () => {
    const encoded = encodeFrame({ type: 'DATA', streamId: 7, data: Buffer.from('hello') });
    const pool = Buffer.alloc(encoded.length + 16, 0xee);
    Buffer.from(encoded).copy(pool, 8);
    const view = pool.subarray(8, 8 + encoded.length);

    const decoded = decodeFrame(view);
    expect(decoded.type).toBe('DATA');
    expect(Buffer.from((decoded as Extract<Frame, { type: 'DATA' }>).data).toString('utf8')).toBe('hello');
  });
});

describe('codec — the encoder refuses to emit anything the peer would reject', () => {
  const illegal: Array<{ name: string; frame: Frame }> = [
    { name: 'DATA over the payload limit', frame: { type: 'DATA', streamId: 1, data: new Uint8Array(MAX_DATA_PAYLOAD + 1) } },
    { name: 'empty DATA', frame: { type: 'DATA', streamId: 1, data: new Uint8Array(0) } },
    { name: 'DATA on the session stream', frame: { type: 'DATA', streamId: 0, data: Uint8Array.from([1]) } },
    { name: 'END on the session stream', frame: { type: 'END', streamId: 0 } },
    { name: 'RST on the session stream', frame: { type: 'RST', streamId: 0, code: ErrorCode.RESET } },
    { name: 'WINDOW with a zero increment', frame: { type: 'WINDOW', streamId: 1, increment: 0 } },
    { name: 'WINDOW above MAX_WINDOW', frame: { type: 'WINDOW', streamId: 1, increment: 2147483648 } },
    { name: 'PING on a stream id', frame: { type: 'PING', streamId: 1 as unknown as 0, nonce: 1n } },
    { name: 'GOAWAY with an over-long reason', frame: { type: 'GOAWAY', streamId: 0, code: ErrorCode.GOING_AWAY, reason: 'x'.repeat(1025) } },
    { name: 'OPEN with an over-long requestId', frame: { type: 'OPEN', streamId: 1, metadata: { kind: 'http', requestId: 'r'.repeat(129) } } },
    { name: 'PROBE with a URL instead of a path', frame: { type: 'PROBE', streamId: 1, request: { path: 'http://169.254.169.254/' } } },
    { name: 'PROBE on probe id 0', frame: { type: 'PROBE', streamId: 0, request: { path: '/' } } },
    { name: 'PROBE_RESULT with a negative elapsedMs', frame: { type: 'PROBE_RESULT', streamId: 1, result: { elapsedMs: -1 } } },
    { name: 'PROBE_RESULT with an impossible status', frame: { type: 'PROBE_RESULT', streamId: 1, result: { status: 99, elapsedMs: 1 } } },
    { name: 'a stream id above u32', frame: { type: 'END', streamId: 0x1_0000_0000 } },
  ];

  it.each(illegal)('refuses $name', ({ frame }) => {
    expect(() => encodeFrame(frame)).toThrow(ProtocolError);
  });

  it('drops OPEN metadata fields that are not part of the spec, so no address can ride along', () => {
    const encoded = encodeFrame({
      type: 'OPEN',
      streamId: 1,
      metadata: { kind: 'http', target: '10.0.0.5:22', addr: '169.254.169.254' } as OpenMetadata,
    });
    const payload = Buffer.from(encoded).subarray(5).toString('utf8');
    expect(payload).toBe('{"kind":"http"}');
  });
});
