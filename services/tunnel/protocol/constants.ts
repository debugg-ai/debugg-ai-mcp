/**
 * Debugg tunnel wire protocol v1 — constants.
 *
 * ONE source of truth for both sides of the wire: the MCP tunnel client in this
 * repo and the debugg tunnel server in the debuggai-api stack. The full
 * specification these values come from is recorded on bead
 * debugg_ai_mcp-xkoh.1.2 (1.2 System Requirements), and the design context is
 * docs/debugg-tunnel-server-design-2026-09-19.md §3.
 *
 * This file — and every other file under services/tunnel/protocol/ — imports
 * nothing but node: built-ins. No logger, no config, no ws. The module has to
 * stay embeddable in a service that is deployed from a different repo, and
 * config/index.ts alone would drag DEBUGGAI_API_KEY validation into it.
 */

/** The only protocol version that exists today. */
export const PROTOCOL_VERSION = 1;

/** Versions this build can speak, best first. Sent in X-Debugg-Tunnel-Protocol. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1]);

// ── Frame geometry ───────────────────────────────────────────────────────────

/** type (u8) + streamId (u32 BE). */
export const HEADER_SIZE = 5;

/** Largest DATA payload in one frame. */
export const MAX_DATA_PAYLOAD = 65536;

/**
 * Largest legal websocket message. Both ends set ws `maxPayload` to this, so an
 * oversized message is refused by the ws layer (1009) before it is buffered.
 */
export const MAX_FRAME_SIZE = HEADER_SIZE + MAX_DATA_PAYLOAD;

/** Largest JSON payload (OPEN / PROBE / PROBE_RESULT). */
export const MAX_JSON_PAYLOAD = 16384;

/** Largest GOAWAY reason, in UTF-8 bytes (the u16 code is not counted). */
export const MAX_GOAWAY_REASON_BYTES = 1024;

/** Largest PROBE path. */
export const MAX_PROBE_PATH_LENGTH = 2048;

/** Largest OPEN `requestId`. */
export const MAX_REQUEST_ID_LENGTH = 128;

/** Largest OPEN `kind`. */
export const MAX_KIND_LENGTH = 32;

/** Largest PROBE_RESULT `marker`. */
export const MAX_MARKER_LENGTH = 64;

/** Largest PROBE_RESULT `error`. */
export const MAX_ERROR_LENGTH = 256;

// ── Streams ──────────────────────────────────────────────────────────────────

/** streamId 0 is reserved for session-level frames (PING/PONG/GOAWAY). */
export const SESSION_STREAM_ID = 0;

/** Highest u32 stream id. Reaching it means GOAWAY + reconnect. */
export const MAX_STREAM_ID = 0xffffffff;

/**
 * Concurrent streams per tunnel. One Next.js dev page has been measured at 54
 * requests, and nginx deliberately has no upstream keepalive for the tunnel, so
 * one browser request is one stream.
 */
export const MAX_CONCURRENT_STREAMS = 256;

// ── Flow control ─────────────────────────────────────────────────────────────

/** Credit each stream direction starts with. Fixed in v1, not negotiated. */
export const INITIAL_WINDOW = 262144;

/** A window may never exceed this after a WINDOW increment. */
export const MAX_WINDOW = 2147483647;

/**
 * Receiver policy (pinned by tests, not by the wire): announce consumed bytes
 * once this many are un-announced, so the sender never stalls while three
 * quarters of the window is still in flight.
 */
export const WINDOW_UPDATE_THRESHOLD = 65536;

/**
 * Send-side bound: the session hands frames to the socket only while fewer than
 * this many bytes are un-acked (ws send callback still pending), so a peer that
 * stops reading cannot inflate the websocket's own send buffer.
 */
export const MAX_UNACKED_SEND_BYTES = 262144;

// ── Timers ───────────────────────────────────────────────────────────────────

/** PING cadence. Under the public ALB's idle_timeout of 60s. */
export const PING_INTERVAL_MS = 20000;

/** No frame of any type for this long means the peer is dead. */
export const DEAD_PEER_TIMEOUT_MS = 60000;

/** Client-side PROBE deadline. Matches TunnelHealthProbeOptions.timeoutMs today. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * Normative for the tunnel server: how long a browser request is held while the
 * tunnel's client is reconnecting, before DEBUGG_TUNNEL_OFFLINE is rendered.
 */
export const RECONNECT_GRACE_MS = 5000;

// ── Frame types ──────────────────────────────────────────────────────────────

export const FrameType = Object.freeze({
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
} as const);

export type FrameTypeName = keyof typeof FrameType;
export type FrameTypeCode = (typeof FrameType)[FrameTypeName];

// ── Error codes (RST payload, GOAWAY payload, and websocket close 4000+code) ──

export const ErrorCode = Object.freeze({
  /** Stream was NOT processed — cap reached, or OPEN after GOAWAY. Retryable. */
  REFUSED: 1,
  /** Stream aborted by an endpoint. */
  RESET: 2,
  /** A deadline expired (dead peer, drain deadline). */
  TIMEOUT: 3,
  /** The peer violated the spec. */
  PROTOCOL_ERROR: 4,
  /** Sender is shutting down; reconnect. */
  GOING_AWAY: 5,
  /** Client could not dial its local target -> DEBUGG_TUNNEL_UPSTREAM_REFUSED. */
  UPSTREAM_UNREACHABLE: 6,
  /** Tunnel revoked or past its max lifetime. Do not reconnect with this token. */
  REVOKED: 7,
} as const);

export type ErrorCodeName = keyof typeof ErrorCode;
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];

/** Websocket close codes. Anything other than a drained close is 4000 + ErrorCode. */
export const CloseCode = Object.freeze({
  NORMAL: 1000,
  /** RFC 6455: the connection dropped without a close frame. Never sent, only observed. */
  ABNORMAL: 1006,
  REFUSED: 4001,
  RESET: 4002,
  TIMEOUT: 4003,
  PROTOCOL_ERROR: 4004,
  GOING_AWAY: 4005,
  UPSTREAM_UNREACHABLE: 4006,
  REVOKED: 4007,
} as const);

/** Close code carrying a protocol error code. */
export const CLOSE_CODE_BASE = 4000;

// ── Handshake ────────────────────────────────────────────────────────────────

/**
 * Header names, lowercase, because that is how node hands them to a server
 * (http.IncomingMessage.headers). The canonical spellings a client sends are in
 * REQUEST_HEADER_NAMES.
 */
export const Header = Object.freeze({
  AUTHORIZATION: 'authorization',
  TUNNEL_ID: 'x-debugg-tunnel-id',
  PROTOCOL: 'x-debugg-tunnel-protocol',
  CLIENT_VERSION: 'x-debugg-tunnel-client-version',
  SUPPORTED: 'x-debugg-tunnel-supported',
  /** Response header on the server's error pages, alongside the body marker. */
  TUNNEL_ERROR: 'x-debugg-tunnel-error',
} as const);

export const RequestHeader = Object.freeze({
  AUTHORIZATION: 'Authorization',
  TUNNEL_ID: 'X-Debugg-Tunnel-Id',
  PROTOCOL: 'X-Debugg-Tunnel-Protocol',
  CLIENT_VERSION: 'X-Debugg-Tunnel-Client-Version',
  SUPPORTED: 'X-Debugg-Tunnel-Supported',
} as const);

/** A tunnel id has to be a DNS label: it becomes `<id>.tunnel.debugg.ai`. */
export const TUNNEL_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Handshake rejection statuses. */
export const HandshakeStatus = Object.freeze({
  SWITCHING_PROTOCOLS: 101,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  UPGRADE_REQUIRED: 426,
} as const);

export const HandshakeError = Object.freeze({
  UNSUPPORTED_PROTOCOL_VERSION: 'UNSUPPORTED_PROTOCOL_VERSION',
  BAD_TUNNEL_ID: 'BAD_TUNNEL_ID',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const);

// ── Server error markers (server emits, client parses) ───────────────────────

export const TunnelErrorMarker = Object.freeze({
  /** No client connected — the ERR_NGROK_3200 analogue. */
  OFFLINE: 'DEBUGG_TUNNEL_OFFLINE',
  /** Unknown or revoked tunnel id. */
  UNKNOWN: 'DEBUGG_TUNNEL_UNKNOWN',
  /** The client could not dial the local app — the ERR_NGROK_8012 analogue. */
  UPSTREAM_REFUSED: 'DEBUGG_TUNNEL_UPSTREAM_REFUSED',
} as const);

export type TunnelErrorMarkerValue = (typeof TunnelErrorMarker)[keyof typeof TunnelErrorMarker];

/** HTTP status each marker is served with, chosen to match the ngrok codes they replace. */
export const MARKER_HTTP_STATUS: Readonly<Record<TunnelErrorMarkerValue, number>> = Object.freeze({
  [TunnelErrorMarker.OFFLINE]: 404,
  [TunnelErrorMarker.UNKNOWN]: 404,
  [TunnelErrorMarker.UPSTREAM_REFUSED]: 502,
});
