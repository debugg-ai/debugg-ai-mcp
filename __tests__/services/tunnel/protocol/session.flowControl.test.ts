/**
 * Session — credit flow control, bounded memory and per-stream fairness.
 * Bead debugg_ai_mcp-xkoh.1.3 (2.1). Spec: bead debugg_ai_mcp-xkoh.1.2 §5/§6.
 *
 * This is the file that exists because of the risk called out in 3.1: a
 * backpressure bug here doesn't fail loudly, it just quietly buffers a dev
 * server's whole bundle in the MCP's heap.
 */

import { Readable } from 'node:stream';
import { once } from 'node:events';
import { TunnelSession } from '../../../../services/tunnel/protocol/session.js';
import type { TunnelStream } from '../../../../services/tunnel/protocol/stream.js';
import { StreamResetError } from '../../../../services/tunnel/protocol/errors.js';
import {
  ErrorCode,
  INITIAL_WINDOW,
  MAX_DATA_PAYLOAD,
  MAX_UNACKED_SEND_BYTES,
  WINDOW_UPDATE_THRESHOLD,
} from '../../../../services/tunnel/protocol/constants.js';
import { FakeTransport, MemoryTransport, RawType, memoryPair, raw, tick, waitFor } from './helpers.js';

const sessions: TunnelSession[] = [];

function serverSession(transport = new FakeTransport()): { session: TunnelSession; transport: FakeTransport } {
  const session = new TunnelSession(transport, { role: 'server' });
  sessions.push(session);
  return { session, transport };
}

function clientSession(transport = new FakeTransport()): { session: TunnelSession; transport: FakeTransport } {
  const session = new TunnelSession(transport, { role: 'client' });
  sessions.push(session);
  return { session, transport };
}

function sessionPair(): {
  client: TunnelSession;
  server: TunnelSession;
  serverTransport: MemoryTransport;
  inbound: TunnelStream[];
} {
  const { client: clientTransport, server: serverTransport } = memoryPair();
  const client = new TunnelSession(clientTransport, { role: 'client' });
  const server = new TunnelSession(serverTransport, { role: 'server' });
  sessions.push(client, server);
  const inbound: TunnelStream[] = [];
  client.on('stream', (stream: TunnelStream) => {
    stream.on('error', () => undefined);
    inbound.push(stream);
  });
  return { client, server, serverTransport, inbound };
}

function lazySource(total: number, chunkSize = 16384): { stream: Readable; produced: () => number } {
  let produced = 0;
  const stream = new Readable({
    read() {
      if (produced >= total) {
        this.push(null);
        return;
      }
      const size = Math.min(chunkSize, total - produced);
      produced += size;
      this.push(Buffer.alloc(size, 0x62));
    },
  });
  return { stream, produced: () => produced };
}

afterEach(() => {
  while (sessions.length > 0) {
    const session = sessions.pop();
    try {
      session?.close();
    } catch {
      /* stub or already closed */
    }
  }
});

describe('flow control — the send side', () => {
  it('stops at the initial window and resumes when credit arrives', async () => {
    const { session, transport } = serverSession();
    const stream = session.openStream();
    // Bigger than INITIAL_WINDOW + the first grant, so "resumed, and only by as
    // much as it was granted" is actually observable.
    const total = 400 * 1024;

    stream.write(Buffer.alloc(total, 0x41));

    await waitFor(() => transport.bytesSentOfType(RawType.DATA) === INITIAL_WINDOW, {
      label: 'window exhausted',
    });
    await tick(20);
    expect(transport.bytesSentOfType(RawType.DATA)).toBe(INITIAL_WINDOW);

    transport.deliver(raw.window(stream.id, 65536));
    await waitFor(() => transport.bytesSentOfType(RawType.DATA) === INITIAL_WINDOW + 65536, {
      label: 'first grant consumed',
    });

    transport.deliver(raw.window(stream.id, 1024 * 1024));
    await waitFor(() => transport.bytesSentOfType(RawType.DATA) === total, { label: 'all data sent' });
  });

  it('never sends past the credit it has been granted', async () => {
    const { session, transport } = serverSession();
    const stream = session.openStream();
    stream.write(Buffer.alloc(400 * 1024, 0x42));

    let granted = INITIAL_WINDOW;
    await waitFor(() => transport.bytesSentOfType(RawType.DATA) === granted, { label: 'initial window used' });

    for (let i = 0; i < 5; i++) {
      expect(transport.bytesSentOfType(RawType.DATA)).toBeLessThanOrEqual(granted);
      transport.deliver(raw.window(stream.id, 1000));
      granted += 1000;
      await waitFor(() => transport.bytesSentOfType(RawType.DATA) === granted, { label: `grant ${i}` });
      expect(transport.framesOfType(RawType.DATA).every((f) => f.payload.length <= MAX_DATA_PAYLOAD)).toBe(true);
    }
  });

  it('keeps at most MAX_UNACKED_SEND_BYTES in the socket, however much credit it has', async () => {
    const transport = new FakeTransport({ autoAck: false });
    const { session } = serverSession(transport);
    const stream = session.openStream();

    transport.deliver(raw.window(stream.id, 16 * 1024 * 1024));
    stream.write(Buffer.alloc(4 * 1024 * 1024, 0x43));
    await tick(30);

    const handedOver = transport.bytesSentOfType(RawType.DATA);
    expect(handedOver).toBeGreaterThan(0);
    expect(handedOver).toBeLessThanOrEqual(MAX_UNACKED_SEND_BYTES + MAX_DATA_PAYLOAD);

    transport.flushAcks();
    await waitFor(() => transport.bytesSentOfType(RawType.DATA) > handedOver, { label: 'sending resumes' });
  });

  it('holds a piped producer back instead of buffering its output', async () => {
    const { session, transport } = serverSession();
    const stream = session.openStream();
    const { stream: source, produced } = lazySource(8 * 1024 * 1024);

    source.pipe(stream);

    await waitFor(() => transport.bytesSentOfType(RawType.DATA) === INITIAL_WINDOW, {
      label: 'window exhausted',
    });
    await tick(30);

    // Everything the producer made beyond the window is sitting in node's own
    // stream buffers — a couple of high water marks, not megabytes.
    expect(produced()).toBeLessThan(INITIAL_WINDOW + 512 * 1024);
    source.destroy();
  });
});

describe('flow control — the receive side', () => {
  async function openInbound(): Promise<{
    session: TunnelSession;
    transport: FakeTransport;
    stream: TunnelStream;
  }> {
    const { session, transport } = clientSession();
    const streamPromise = once(session, 'stream');
    transport.deliver(raw.open(1, { kind: 'http' }));
    const [stream] = (await streamPromise) as [TunnelStream];
    stream.on('error', () => undefined);
    return { session, transport, stream };
  }

  it('buffers at most one window for an application that is not reading', async () => {
    const { transport, stream } = await openInbound();

    for (let sent = 0; sent < INITIAL_WINDOW; sent += MAX_DATA_PAYLOAD) {
      transport.deliver(raw.data(1, Buffer.alloc(MAX_DATA_PAYLOAD, 0x44)));
    }
    await tick(20);

    expect(transport.framesOfType(RawType.WINDOW)).toHaveLength(0);
    expect(stream.readableLength).toBeLessThanOrEqual(INITIAL_WINDOW);
  });

  it('resets a stream that overruns its window instead of buffering the excess', async () => {
    const { session, transport, stream } = await openInbound();
    for (let sent = 0; sent < INITIAL_WINDOW; sent += MAX_DATA_PAYLOAD) {
      transport.deliver(raw.data(1, Buffer.alloc(MAX_DATA_PAYLOAD, 0x44)));
    }
    const errorPromise = once(stream, 'error');

    transport.deliver(raw.data(1, Buffer.from('one byte too many')));

    const [err] = (await errorPromise) as [StreamResetError];
    expect(err.code).toBe(ErrorCode.PROTOCOL_ERROR);
    expect(transport.framesOfType(RawType.RST)[0]).toMatchObject({ streamId: 1, code: ErrorCode.PROTOCOL_ERROR });
    expect(stream.readableLength).toBeLessThanOrEqual(INITIAL_WINDOW);
    // Stream-scoped: the other streams on this tunnel are fine.
    expect(transport.closedWith).toBeUndefined();
    expect(session.closed).toBe(false);
  });

  it('grants credit as the application consumes, and never in advance of it', async () => {
    const { transport, stream } = await openInbound();
    for (let sent = 0; sent < INITIAL_WINDOW; sent += MAX_DATA_PAYLOAD) {
      transport.deliver(raw.data(1, Buffer.alloc(MAX_DATA_PAYLOAD, 0x44)));
    }
    expect(transport.framesOfType(RawType.WINDOW)).toHaveLength(0);

    let consumed = 0;
    stream.on('data', (chunk: Buffer) => {
      consumed += chunk.length;
    });

    await waitFor(() => consumed === INITIAL_WINDOW, { label: 'application drains the buffer' });
    await tick(20);

    const granted = transport
      .framesOfType(RawType.WINDOW)
      .reduce((sum, frame) => sum + (frame.increment ?? 0), 0);
    expect(granted).toBeLessThanOrEqual(consumed);
    expect(granted).toBeGreaterThanOrEqual(consumed - WINDOW_UPDATE_THRESHOLD);
  });
});

describe('transfers larger than one window', () => {
  it('keeps flowing past the first window when the consumer is a data listener', async () => {
    // The deadlock this exists for: node's flowing mode hands a pushed chunk
    // straight to the 'data' listener, so it never enters the readable buffer.
    // Counting consumption only at read() therefore misses those bytes, no
    // WINDOW is ever sent back, and everything past the first 256 KiB stalls
    // forever. Four megabytes is sixteen windows' worth — it cannot pass by
    // accident.
    const { server, inbound } = sessionPair();
    const total = 4 * 1024 * 1024;

    const stream = server.openStream({ kind: 'http' });
    await waitFor(() => inbound.length === 1, { label: 'stream surfaced' });
    let consumed = 0;
    inbound[0].on('data', (chunk: Buffer) => {
      consumed += chunk.length;
    });
    stream.end(Buffer.alloc(total, 0x51));

    await waitFor(() => consumed === total, { label: 'whole transfer arrives', timeoutMs: 10_000 });
    expect(consumed).toBe(total);
  });
});

describe('fairness', () => {
  it('lets a small stream through while a large one is saturating the tunnel', async () => {
    const { server, serverTransport, inbound } = sessionPair();

    const big = server.openStream({ kind: 'http', requestId: 'big' });
    await waitFor(() => inbound.length === 1, { label: 'big stream surfaced' });
    inbound[0].resume(); // the client reads continuously, so credit keeps coming

    big.write(Buffer.alloc(10 * 1024 * 1024, 0x45));
    await waitFor(() => serverTransport.bytesSentOfType(RawType.DATA) > 3 * MAX_DATA_PAYLOAD, {
      label: 'big stream is flowing',
    });

    const small = server.openStream({ kind: 'http', requestId: 'small' });
    const mark = serverTransport.sent.length;
    small.end(Buffer.alloc(1024, 0x46));

    await waitFor(
      () => serverTransport.frames().some((f, i) => i >= mark && f.type === RawType.DATA && f.streamId === small.id),
      { label: 'small stream gets a turn' },
    );

    const after = serverTransport.frames().slice(mark);
    const smallIndex = after.findIndex((f) => f.type === RawType.DATA && f.streamId === small.id);
    const bigFramesAhead = after
      .slice(0, smallIndex)
      .filter((f) => f.type === RawType.DATA && f.streamId === big.id).length;

    expect(bigFramesAhead).toBeLessThanOrEqual(1);
    big.destroy();
  });
});
