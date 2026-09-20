/**
 * Debugg tunnel wire protocol v1 — transport seam.
 *
 * TunnelSession never touches a websocket directly. It talks to a FrameTransport,
 * which is what lets the unit tests drive a session frame by frame (and with fake
 * timers) while the integration tests run the same session over a real `ws`
 * socket. `ws` is referenced only structurally here, so this module keeps its
 * "node: built-ins only" property and stays embeddable in the tunnel server.
 */

/** Inbound events a transport delivers to its session. Registered exactly once. */
export interface TransportHandlers {
  /** One inbound websocket binary message == one encoded frame. */
  onFrame(bytes: Uint8Array): void;
  /** A message that can never be a frame (e.g. a text message). Session-fatal. */
  onInvalidMessage(detail: string): void;
  /** The connection is gone. `code` is the websocket close code (1006 if abrupt). */
  onClose(code: number, reason: string): void;
}

export interface FrameTransport {
  /**
   * Send one encoded frame as one binary message. `cb` runs once the bytes have
   * been handed to the OS (ws's send-callback semantics), or with an error. The
   * session uses that callback for its un-acked-bytes bound.
   */
  send(frame: Uint8Array, cb: (err?: Error | null) => void): void;
  /** Graceful websocket close. */
  close(code: number, reason: string): void;
  /** Immediate teardown, for a peer that has stopped answering. */
  terminate(): void;
  /** Called once by TunnelSession when it takes ownership of the transport. */
  setHandlers(handlers: TransportHandlers): void;
}

/**
 * The slice of `ws`'s WebSocket this module needs. Structural on purpose: the
 * protocol module must not depend on the `ws` package (or on @types/ws) to
 * compile.
 */
export interface WebSocketLike {
  send(data: Uint8Array, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** RFC 6455: the connection dropped without a close handshake. */
const ABNORMAL_CLOSURE = 1006;

/** ws hands out Buffer, ArrayBuffer, or an array of Buffers for a fragmented message. */
function toBytes(data: unknown): Uint8Array | undefined {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) return Buffer.concat(data as Buffer[]);
  return undefined;
}

function reasonToString(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (Buffer.isBuffer(reason)) return reason.toString('utf8');
  if (reason instanceof ArrayBuffer) return Buffer.from(reason).toString('utf8');
  return '';
}

/**
 * Adapt a ws WebSocket (client or server side) to a FrameTransport.
 *
 * Responsibilities: normalise inbound data to a Uint8Array, reject text messages
 * as invalid, and make sure the session is told exactly once that the socket is
 * gone — whichever of 'close' and 'error' happens to fire, and in whichever
 * order.
 */
export function webSocketTransport(ws: WebSocketLike): FrameTransport {
  let handlers: TransportHandlers | undefined;
  let closed = false;
  let socketError: Error | undefined;

  const reportClose = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    handlers?.onClose(code, reason);
  };

  return {
    send(frame: Uint8Array, cb: (err?: Error | null) => void): void {
      if (closed) {
        cb(new Error('websocket is closed'));
        return;
      }
      try {
        ws.send(frame, (err) => cb(err ?? null));
      } catch (err) {
        cb(err as Error);
      }
    },

    close(code: number, reason: string): void {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing; the close event still settles the session */
      }
    },

    terminate(): void {
      try {
        ws.terminate();
      } catch {
        /* nothing left to tear down */
      }
    },

    setHandlers(next: TransportHandlers): void {
      handlers = next;
      ws.on('message', (data: unknown, isBinary: boolean) => {
        if (closed) return;
        if (!isBinary) {
          next.onInvalidMessage('text message');
          return;
        }
        const bytes = toBytes(data);
        if (!bytes) {
          next.onInvalidMessage('message was not binary data');
          return;
        }
        next.onFrame(bytes);
      });
      ws.on('error', (err: Error) => {
        // ws emits 'close' after 'error' for a live socket, so hold the reason
        // and let the close path report it — unless no close ever arrives.
        socketError = err;
      });
      ws.on('close', (code: number, reason: unknown) => {
        reportClose(code || ABNORMAL_CLOSURE, reasonToString(reason) || socketError?.message || '');
      });
    },
  };
}
