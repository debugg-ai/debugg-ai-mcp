/**
 * Debugg tunnel wire protocol v1 — frame codec.
 *
 * Wire layout, one frame per websocket BINARY message:
 *
 *   offset 0, 1 byte : type (u8)
 *   offset 1, 4 bytes: streamId (u32 big-endian)
 *   offset 5, N bytes: payload
 *
 * The full table of types, payload shapes and rejection rules is on bead
 * debugg_ai_mcp-xkoh.1.2, and pinned byte-for-byte by vectors/frames.json and
 * vectors/invalid-frames.json.
 *
 * Pure and synchronous: no state, no IO, no timers, and no imports beyond this
 * directory — the module is vendored verbatim into the tunnel server's repo.
 */

import { ProtocolError } from './errors.js';
import {
  FrameType,
  HEADER_SIZE,
  MAX_DATA_PAYLOAD,
  MAX_ERROR_LENGTH,
  MAX_GOAWAY_REASON_BYTES,
  MAX_JSON_PAYLOAD,
  MAX_KIND_LENGTH,
  MAX_MARKER_LENGTH,
  MAX_PROBE_PATH_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MAX_STREAM_ID,
  MAX_WINDOW,
} from './constants.js';

/**
 * OPEN metadata. Purely informational: a receiver MUST NOT derive a dial target
 * from any of it, and the decoder drops every field that isn't listed here —
 * that whitelist is the SSRF boundary, not a nicety.
 */
export interface OpenMetadata {
  /** "http" for a browser connection, "probe" for a server-issued health probe. */
  kind?: string;
  /** Opaque id for correlating this stream's logs on both sides. */
  requestId?: string;
}

/** PROBE payload. */
export interface ProbeRequest {
  /** Absolute path, always starting with "/". Never a URL. */
  path: string;
}

/** PROBE_RESULT payload. */
export interface ProbeResult {
  /** HTTP status the local app returned, when there was a response. */
  status?: number;
  /** A DEBUGG_TUNNEL_* marker, when the tunnel itself failed. */
  marker?: string;
  /** "TIMEOUT" | "RESET" | "CLOSED" | ... when there was no HTTP response at all. */
  error?: string;
  /** Always present. */
  elapsedMs: number;
}

export type Frame =
  | { type: 'OPEN'; streamId: number; metadata: OpenMetadata }
  | { type: 'DATA'; streamId: number; data: Uint8Array }
  | { type: 'END'; streamId: number }
  | { type: 'RST'; streamId: number; code: number }
  | { type: 'WINDOW'; streamId: number; increment: number }
  | { type: 'PING'; streamId: 0; nonce: bigint }
  | { type: 'PONG'; streamId: 0; nonce: bigint }
  | { type: 'GOAWAY'; streamId: 0; code: number; reason: string }
  | { type: 'PROBE'; streamId: number; request: ProbeRequest }
  | { type: 'PROBE_RESULT'; streamId: number; result: ProbeResult };

export type FrameOfType<T extends Frame['type']> = Extract<Frame, { type: T }>;

const TYPE_NAME_BY_CODE = new Map<number, Frame['type']>(
  Object.entries(FrameType).map(([name, code]) => [code as number, name as Frame['type']]),
);

const MAX_U64 = (1n << 64n) - 1n;

/** Strict: invalid UTF-8 is a protocol error, never a replacement character. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

function fail(detail: string): never {
  throw new ProtocolError(detail);
}

function requireStreamId(streamId: unknown, type: string): number {
  if (typeof streamId !== 'number' || !Number.isInteger(streamId) || streamId < 1 || streamId > MAX_STREAM_ID) {
    fail(`${type}: stream id must be an integer in 1..${MAX_STREAM_ID}, got ${String(streamId)}`);
  }
  return streamId;
}

function requireSessionStreamId(streamId: unknown, type: string): void {
  if (streamId !== 0) fail(`${type}: session frames use stream id 0, got ${String(streamId)}`);
}

function requireU16(value: unknown, type: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff) {
    fail(`${type}: ${field} must be a u16, got ${String(value)}`);
  }
  return value;
}

function header(type: number, streamId: number, payloadLength: number): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_SIZE + payloadLength);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId >>> 0, 1);
  return buf;
}

function encodeJsonPayload(obj: Record<string, unknown>, type: string): Buffer {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  if (payload.length > MAX_JSON_PAYLOAD) {
    fail(`${type}: JSON payload is ${payload.length} bytes, limit is ${MAX_JSON_PAYLOAD}`);
  }
  return payload;
}

// ── JSON payload shapes ──────────────────────────────────────────────────────

function checkOptionalString(
  value: unknown,
  maxLength: number,
  type: string,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${type}: ${field} must be a string`);
  if (value.length > maxLength) fail(`${type}: ${field} is longer than ${maxLength} characters`);
  return value;
}

/**
 * Keep only the fields v1 defines, in spec order. Everything else is dropped —
 * including anything address-shaped, which is what stops a server from ever
 * telling a client where to dial.
 */
function normalizeMetadata(value: Record<string, unknown>): OpenMetadata {
  const kind = checkOptionalString(value.kind, MAX_KIND_LENGTH, 'OPEN', 'kind');
  const requestId = checkOptionalString(value.requestId, MAX_REQUEST_ID_LENGTH, 'OPEN', 'requestId');
  const metadata: OpenMetadata = {};
  if (kind !== undefined) metadata.kind = kind;
  if (requestId !== undefined) metadata.requestId = requestId;
  return metadata;
}

function normalizeProbeRequest(value: Record<string, unknown>): ProbeRequest {
  const path = value.path;
  if (typeof path !== 'string') fail('PROBE: path is required and must be a string');
  if (!path.startsWith('/')) fail('PROBE: path must start with "/" — a probe can never be pointed elsewhere');
  if (path.length > MAX_PROBE_PATH_LENGTH) fail(`PROBE: path is longer than ${MAX_PROBE_PATH_LENGTH} characters`);
  return { path };
}

function normalizeProbeResult(value: Record<string, unknown>): ProbeResult {
  const { status, elapsedMs } = value;
  if (status !== undefined) {
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      fail('PROBE_RESULT: status must be an integer in 100..599');
    }
  }
  const marker = checkOptionalString(value.marker, MAX_MARKER_LENGTH, 'PROBE_RESULT', 'marker');
  const error = checkOptionalString(value.error, MAX_ERROR_LENGTH, 'PROBE_RESULT', 'error');
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    fail('PROBE_RESULT: elapsedMs is required and must be a finite number >= 0');
  }
  // Rebuilt in spec order (status, marker, error, elapsedMs) so the encoding is
  // canonical whatever order the caller's object happened to use.
  const out: ProbeResult = { elapsedMs };
  const ordered: Record<string, unknown> = {};
  if (status !== undefined) ordered.status = status;
  if (marker !== undefined) ordered.marker = marker;
  if (error !== undefined) ordered.error = error;
  ordered.elapsedMs = out.elapsedMs;
  return ordered as unknown as ProbeResult;
}

function parseJsonObject(payload: Buffer, type: string): Record<string, unknown> {
  if (payload.length === 0) fail(`${type}: payload must be a JSON object`);
  if (payload.length > MAX_JSON_PAYLOAD) {
    fail(`${type}: JSON payload is ${payload.length} bytes, limit is ${MAX_JSON_PAYLOAD}`);
  }
  let text: string;
  try {
    text = utf8.decode(payload);
  } catch {
    return fail(`${type}: payload is not valid UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(`${type}: payload is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail(`${type}: payload must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

// ── encode ───────────────────────────────────────────────────────────────────

/**
 * Encode one frame. Throws ProtocolError rather than emitting anything the peer
 * would have to reject (oversized DATA, a zero WINDOW increment, streamId 0 on a
 * stream frame, ...).
 *
 * JSON payloads are canonical: known fields only, in spec order, no whitespace.
 */
export function encodeFrame(frame: Frame): Uint8Array {
  switch (frame.type) {
    case 'OPEN': {
      const streamId = requireStreamId(frame.streamId, 'OPEN');
      const metadata = normalizeMetadata((frame.metadata ?? {}) as Record<string, unknown>);
      const ordered: Record<string, unknown> = {};
      if (metadata.kind !== undefined) ordered.kind = metadata.kind;
      if (metadata.requestId !== undefined) ordered.requestId = metadata.requestId;
      const payload = encodeJsonPayload(ordered, 'OPEN');
      const buf = header(FrameType.OPEN, streamId, payload.length);
      payload.copy(buf, HEADER_SIZE);
      return buf;
    }
    case 'DATA': {
      const streamId = requireStreamId(frame.streamId, 'DATA');
      const data = frame.data;
      if (!data || data.length === 0) fail('DATA: payload must be 1..' + MAX_DATA_PAYLOAD + ' bytes');
      if (data.length > MAX_DATA_PAYLOAD) {
        fail(`DATA: payload is ${data.length} bytes, limit is ${MAX_DATA_PAYLOAD}`);
      }
      const buf = header(FrameType.DATA, streamId, data.length);
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(buf, HEADER_SIZE);
      return buf;
    }
    case 'END':
      return header(FrameType.END, requireStreamId(frame.streamId, 'END'), 0);
    case 'RST': {
      const streamId = requireStreamId(frame.streamId, 'RST');
      const code = requireU16(frame.code, 'RST', 'code');
      const buf = header(FrameType.RST, streamId, 2);
      buf.writeUInt16BE(code, HEADER_SIZE);
      return buf;
    }
    case 'WINDOW': {
      const streamId = requireStreamId(frame.streamId, 'WINDOW');
      const increment = frame.increment;
      if (!Number.isInteger(increment) || increment < 1 || increment > MAX_WINDOW) {
        fail(`WINDOW: increment must be an integer in 1..${MAX_WINDOW}, got ${String(increment)}`);
      }
      const buf = header(FrameType.WINDOW, streamId, 4);
      buf.writeUInt32BE(increment, HEADER_SIZE);
      return buf;
    }
    case 'PING':
    case 'PONG': {
      requireSessionStreamId(frame.streamId, frame.type);
      const nonce = frame.nonce;
      if (typeof nonce !== 'bigint' || nonce < 0n || nonce > MAX_U64) {
        fail(`${frame.type}: nonce must be a u64`);
      }
      const buf = header(frame.type === 'PING' ? FrameType.PING : FrameType.PONG, 0, 8);
      buf.writeBigUInt64BE(nonce, HEADER_SIZE);
      return buf;
    }
    case 'GOAWAY': {
      requireSessionStreamId(frame.streamId, 'GOAWAY');
      const code = requireU16(frame.code, 'GOAWAY', 'code');
      const reason = Buffer.from(frame.reason ?? '', 'utf8');
      if (reason.length > MAX_GOAWAY_REASON_BYTES) {
        fail(`GOAWAY: reason is ${reason.length} bytes, limit is ${MAX_GOAWAY_REASON_BYTES}`);
      }
      const buf = header(FrameType.GOAWAY, 0, 2 + reason.length);
      buf.writeUInt16BE(code, HEADER_SIZE);
      reason.copy(buf, HEADER_SIZE + 2);
      return buf;
    }
    case 'PROBE': {
      const probeId = requireStreamId(frame.streamId, 'PROBE');
      const request = normalizeProbeRequest((frame.request ?? {}) as unknown as Record<string, unknown>);
      const payload = encodeJsonPayload({ path: request.path }, 'PROBE');
      const buf = header(FrameType.PROBE, probeId, payload.length);
      payload.copy(buf, HEADER_SIZE);
      return buf;
    }
    case 'PROBE_RESULT': {
      const probeId = requireStreamId(frame.streamId, 'PROBE_RESULT');
      const result = normalizeProbeResult((frame.result ?? {}) as unknown as Record<string, unknown>);
      const payload = encodeJsonPayload(result as unknown as Record<string, unknown>, 'PROBE_RESULT');
      const buf = header(FrameType.PROBE_RESULT, probeId, payload.length);
      payload.copy(buf, HEADER_SIZE);
      return buf;
    }
    default:
      return fail(`unknown frame type ${String((frame as { type?: unknown }).type)}`);
  }
}

// ── decode ───────────────────────────────────────────────────────────────────

/**
 * Decode one websocket binary message into a frame.
 *
 * Throws ProtocolError for anything the spec rejects. Honours the view's
 * byteOffset, because ws hands out Buffers backed by a shared pool.
 */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER_SIZE) {
    fail(`frame is ${bytes.length} bytes, shorter than the ${HEADER_SIZE} byte header`);
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = buf.readUInt8(0);
  const streamId = buf.readUInt32BE(1);
  const payload = buf.subarray(HEADER_SIZE);
  const name = TYPE_NAME_BY_CODE.get(type);
  if (!name) fail(`unknown frame type 0x${type.toString(16).padStart(2, '0')}`);

  switch (name) {
    case 'OPEN':
      requireStreamId(streamId, 'OPEN');
      return { type: 'OPEN', streamId, metadata: normalizeMetadata(parseJsonObject(payload, 'OPEN')) };
    case 'DATA':
      requireStreamId(streamId, 'DATA');
      if (payload.length === 0) fail('DATA: payload must be at least 1 byte');
      if (payload.length > MAX_DATA_PAYLOAD) {
        fail(`DATA: payload is ${payload.length} bytes, limit is ${MAX_DATA_PAYLOAD}`);
      }
      return { type: 'DATA', streamId, data: payload };
    case 'END':
      requireStreamId(streamId, 'END');
      if (payload.length !== 0) fail('END: carries no payload');
      return { type: 'END', streamId };
    case 'RST':
      requireStreamId(streamId, 'RST');
      if (payload.length !== 2) fail(`RST: payload must be exactly 2 bytes, got ${payload.length}`);
      return { type: 'RST', streamId, code: payload.readUInt16BE(0) };
    case 'WINDOW': {
      requireStreamId(streamId, 'WINDOW');
      if (payload.length !== 4) fail(`WINDOW: payload must be exactly 4 bytes, got ${payload.length}`);
      const increment = payload.readUInt32BE(0);
      if (increment < 1 || increment > MAX_WINDOW) {
        fail(`WINDOW: increment must be in 1..${MAX_WINDOW}, got ${increment}`);
      }
      return { type: 'WINDOW', streamId, increment };
    }
    case 'PING':
    case 'PONG':
      requireSessionStreamId(streamId, name);
      if (payload.length !== 8) fail(`${name}: nonce must be exactly 8 bytes, got ${payload.length}`);
      return { type: name, streamId: 0, nonce: payload.readBigUInt64BE(0) };
    case 'GOAWAY': {
      requireSessionStreamId(streamId, 'GOAWAY');
      if (payload.length < 2) fail('GOAWAY: payload starts with a u16 code');
      const reasonBytes = payload.subarray(2);
      if (reasonBytes.length > MAX_GOAWAY_REASON_BYTES) {
        fail(`GOAWAY: reason is ${reasonBytes.length} bytes, limit is ${MAX_GOAWAY_REASON_BYTES}`);
      }
      let reason: string;
      try {
        reason = utf8.decode(reasonBytes);
      } catch {
        return fail('GOAWAY: reason is not valid UTF-8');
      }
      return { type: 'GOAWAY', streamId: 0, code: payload.readUInt16BE(0), reason };
    }
    case 'PROBE':
      requireStreamId(streamId, 'PROBE');
      return { type: 'PROBE', streamId, request: normalizeProbeRequest(parseJsonObject(payload, 'PROBE')) };
    case 'PROBE_RESULT':
      requireStreamId(streamId, 'PROBE_RESULT');
      return {
        type: 'PROBE_RESULT',
        streamId,
        result: normalizeProbeResult(parseJsonObject(payload, 'PROBE_RESULT')),
      };
    default:
      return fail(`unknown frame type ${String(name)}`);
  }
}

/** Human-readable frame type name for a wire type byte, or undefined. */
export function frameTypeName(typeCode: number): string | undefined {
  return TYPE_NAME_BY_CODE.get(typeCode);
}
