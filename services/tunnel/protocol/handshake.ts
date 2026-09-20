/**
 * Debugg tunnel wire protocol v1 — the websocket handshake.
 *
 * This module validates the SHAPE of a handshake only. Whether a tunnelKey is
 * real is the tunnel server's business (it asks the debugg API's internal verify
 * endpoint) — the protocol just guarantees both ends agree on how the question
 * is asked and how a refusal is phrased.
 *
 * Check order is version (426) -> tunnel id (400) -> authorization (401), so an
 * old client is told to upgrade even when its token is also bad.
 */

import {
  HandshakeError,
  HandshakeStatus,
  Header,
  RequestHeader,
  SUPPORTED_PROTOCOL_VERSIONS,
  TUNNEL_ID_PATTERN,
} from './constants.js';

/** Node lowercases inbound header names; values may repeat. */
export type IncomingHeaders = Record<string, string | string[] | undefined>;

export interface HandshakeRequest {
  tunnelId: string;
  tunnelKey: string;
  /** e.g. "debugg-ai-mcp/4.3.0". Optional and informational. */
  clientVersion?: string;
  /** Versions to offer, best first. Defaults to SUPPORTED_PROTOCOL_VERSIONS. */
  versions?: readonly number[];
}

export interface HandshakeAccepted {
  ok: true;
  /** The version both ends will speak. */
  version: number;
  tunnelId: string;
  tunnelKey: string;
  clientVersion?: string;
  /** Headers the server must put on its 101 response, including the version echo. */
  responseHeaders: Record<string, string>;
}

export interface HandshakeRejected {
  ok: false;
  status: number;
  /** Machine-readable reason, one of HandshakeError. */
  error: string;
  /** Headers the server must send with the rejection (e.g. the supported list). */
  responseHeaders: Record<string, string>;
  /** JSON body the server must send. */
  body: { error: string; supported?: number[] };
}

export type HandshakeResult = HandshakeAccepted | HandshakeRejected;

const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' };

function headerValue(headers: IncomingHeaders, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join(', ') : raw;
}

/** Build the request headers a client sends with its upgrade request. */
export function buildHandshakeHeaders(request: HandshakeRequest): Record<string, string> {
  const versions = request.versions ?? SUPPORTED_PROTOCOL_VERSIONS;
  const headers: Record<string, string> = {
    [RequestHeader.AUTHORIZATION]: `Bearer ${request.tunnelKey}`,
    [RequestHeader.TUNNEL_ID]: request.tunnelId,
    [RequestHeader.PROTOCOL]: versions.join(', '),
  };
  if (request.clientVersion) headers[RequestHeader.CLIENT_VERSION] = request.clientVersion;
  return headers;
}

/**
 * Pick the highest version both ends speak from an X-Debugg-Tunnel-Protocol
 * header value, or null when there is none. Tolerates whitespace, a repeated
 * header and versions we don't know; anything non-numeric is simply not a
 * version and is ignored.
 */
export function negotiateProtocolVersion(
  offered: string | string[] | undefined,
  supported: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): number | null {
  if (offered === undefined) return null;
  const tokens = (Array.isArray(offered) ? offered.join(',') : offered).split(',');
  let best: number | null = null;
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const version = Number(trimmed);
    if (!supported.includes(version)) continue;
    if (best === null || version > best) best = version;
  }
  return best;
}

/**
 * Server side: validate an upgrade request's headers.
 */
export function validateHandshakeRequest(
  headers: IncomingHeaders,
  supported: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): HandshakeResult {
  const version = negotiateProtocolVersion(headerValue(headers, Header.PROTOCOL), supported);
  if (version === null) {
    return {
      ok: false,
      status: HandshakeStatus.UPGRADE_REQUIRED,
      error: HandshakeError.UNSUPPORTED_PROTOCOL_VERSION,
      responseHeaders: { [RequestHeader.SUPPORTED]: supported.join(', '), ...JSON_CONTENT_TYPE },
      body: { error: HandshakeError.UNSUPPORTED_PROTOCOL_VERSION, supported: [...supported] },
    };
  }

  const tunnelId = headerValue(headers, Header.TUNNEL_ID);
  if (!tunnelId || !TUNNEL_ID_PATTERN.test(tunnelId)) {
    return {
      ok: false,
      status: HandshakeStatus.BAD_REQUEST,
      error: HandshakeError.BAD_TUNNEL_ID,
      responseHeaders: { ...JSON_CONTENT_TYPE },
      body: { error: HandshakeError.BAD_TUNNEL_ID },
    };
  }

  const authorization = headerValue(headers, Header.AUTHORIZATION);
  const bearer = authorization ? /^bearer\s+(\S.*)$/i.exec(authorization) : null;
  if (!bearer) {
    return {
      ok: false,
      status: HandshakeStatus.UNAUTHORIZED,
      error: HandshakeError.UNAUTHORIZED,
      responseHeaders: { ...JSON_CONTENT_TYPE },
      body: { error: HandshakeError.UNAUTHORIZED },
    };
  }

  const accepted: HandshakeAccepted = {
    ok: true,
    version,
    tunnelId,
    tunnelKey: bearer[1].trim(),
    responseHeaders: { [RequestHeader.PROTOCOL]: String(version) },
  };
  const clientVersion = headerValue(headers, Header.CLIENT_VERSION);
  if (clientVersion) accepted.clientVersion = clientVersion;
  return accepted;
}

export interface UpgradeResponseOk {
  ok: true;
  version: number;
}

export interface UpgradeResponseFailure {
  ok: false;
  status: number;
  /** Versions the server advertised on a 426, when it sent any. */
  supported?: number[];
  /**
   * False for 400/401/426 — the same token and build will fail the same way, so
   * the client must re-provision or be upgraded rather than loop.
   */
  retryable: boolean;
}

function parseVersionList(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const versions = value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => /^\d+$/.test(token))
    .map(Number);
  return versions.length > 0 ? versions : undefined;
}

/** Client side: interpret whatever came back instead of (or alongside) a 101. */
export function interpretHandshakeResponse(
  status: number,
  headers: IncomingHeaders,
  offered: readonly number[] = SUPPORTED_PROTOCOL_VERSIONS,
): UpgradeResponseOk | UpgradeResponseFailure {
  if (status === HandshakeStatus.SWITCHING_PROTOCOLS) {
    const echoed = negotiateProtocolVersion(headerValue(headers, Header.PROTOCOL), offered);
    if (echoed === null) {
      // No echo, or a version we never offered: the peer is not speaking a
      // protocol we understand, and pretending otherwise corrupts the stream.
      return { ok: false, status, retryable: false };
    }
    return { ok: true, version: echoed };
  }

  const failure: UpgradeResponseFailure = {
    ok: false,
    status,
    retryable: status === 429 || status >= 500,
  };
  if (status === HandshakeStatus.UPGRADE_REQUIRED) {
    const supported = parseVersionList(headerValue(headers, Header.SUPPORTED));
    if (supported) failure.supported = supported;
  }
  return failure;
}
