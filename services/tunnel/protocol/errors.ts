/**
 * Debugg tunnel wire protocol v1 — error types.
 *
 * STUB (bead debugg_ai_mcp-xkoh.1.3, phase 2.1): these are data-only classes, so
 * they are complete; every behavioural module in this directory is a stub that
 * throws until phase 4.1.
 */

import { ErrorCode } from './constants.js';

/**
 * The peer (or our own encoder's caller) violated the wire spec. Always carries
 * ErrorCode.PROTOCOL_ERROR — the code exists so callers can treat it uniformly
 * with StreamResetError.
 */
export class ProtocolError extends Error {
  readonly code: number = ErrorCode.PROTOCOL_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * A stream ended early. `code` is an ErrorCode value; an unknown code seen on
 * the wire is normalised to ErrorCode.RESET before it gets here. `remote` is
 * true when the peer sent the RST, false when this side originated it (a cap
 * refusal, a GOAWAY drain deadline).
 */
export class StreamResetError extends Error {
  readonly code: number;
  readonly remote: boolean;

  constructor(code: number, message?: string, remote = false) {
    super(message ?? `tunnel stream reset (code ${code})`);
    this.name = 'StreamResetError';
    this.code = code;
    this.remote = remote;
  }
}

/**
 * The session is gone: the websocket closed, the peer went silent, or a fatal
 * protocol error tore it down. `closeCode` is the websocket close code
 * (1000, or 4000 + ErrorCode, or 1006 for an abrupt socket loss).
 */
export class SessionClosedError extends Error {
  readonly closeCode: number;
  readonly reason: string;

  constructor(closeCode: number, reason = '') {
    super(`tunnel session closed (${closeCode}${reason ? `: ${reason}` : ''})`);
    this.name = 'SessionClosedError';
    this.closeCode = closeCode;
    this.reason = reason;
  }
}
