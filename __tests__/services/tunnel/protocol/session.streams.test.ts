/**
 * Session — stream lifecycle, multiplexing and protocol policing.
 * Bead debugg_ai_mcp-xkoh.1.3 (2.1). Spec: bead debugg_ai_mcp-xkoh.1.2 §2/§4.
 */

import { once } from 'node:events';
import { TunnelSession } from '../../../../services/tunnel/protocol/session.js';
import type { TunnelStream } from '../../../../services/tunnel/protocol/stream.js';
import { StreamResetError } from '../../../../services/tunnel/protocol/errors.js';
import {
  CloseCode,
  ErrorCode,
  MAX_CONCURRENT_STREAMS,
  MAX_DATA_PAYLOAD,
} from '../../../../services/tunnel/protocol/constants.js';
import {
  FakeTransport,
  RawType,
  collect,
  deferred,
  memoryPair,
  raw,
  waitFor,
} from './helpers.js';

const sessions: TunnelSession[] = [];

function clientSession(transport = new FakeTransport()): { session: TunnelSession; transport: FakeTransport } {
  const session = new TunnelSession(transport, { role: 'client' });
  sessions.push(session);
  return { session, transport };
}

function serverSession(transport = new FakeTransport()): { session: TunnelSession; transport: FakeTransport } {
  const session = new TunnelSession(transport, { role: 'server' });
  sessions.push(session);
  return { session, transport };
}

function sessionPair(): { client: TunnelSession; server: TunnelSession } {
  const { client: clientTransport, server: serverTransport } = memoryPair();
  const client = new TunnelSession(clientTransport, { role: 'client' });
  const server = new TunnelSession(serverTransport, { role: 'server' });
  sessions.push(client, server);
  return { client, server };
}

/** Collect inbound streams on a client session. */
function inbound(session: TunnelSession): TunnelStream[] {
  const streams: TunnelStream[] = [];
  session.on('stream', (stream: TunnelStream) => {
    stream.on('error', () => undefined); // tests assert on errors explicitly
    streams.push(stream);
  });
  return streams;
}

afterEach(() => {
  while (sessions.length > 0) {
    const session = sessions.pop();
    try {
      session?.close();
    } catch {
      /* a stub session, or one that is already closed */
    }
  }
});

describe('session — opening streams', () => {
  it('allocates strictly increasing stream ids starting at 1', () => {
    const { session, transport } = serverSession();

    session.openStream({ kind: 'http' });
    session.openStream({ kind: 'http' });
    session.openStream({ kind: 'probe' });

    const opens = transport.framesOfType(RawType.OPEN);
    expect(opens.map((f) => f.streamId)).toEqual([1, 2, 3]);
    expect(opens[0].json).toEqual({ kind: 'http' });
    expect(opens[2].json).toEqual({ kind: 'probe' });
  });

  it('surfaces an inbound stream with its metadata', async () => {
    const { session, transport } = clientSession();
    const streamPromise = once(session, 'stream');

    transport.deliver(raw.open(1, { kind: 'http', requestId: 'req-7f3a' }));

    const [stream] = (await streamPromise) as [TunnelStream];
    expect(stream.id).toBe(1);
    expect(stream.metadata).toEqual({ kind: 'http', requestId: 'req-7f3a' });
  });

  it('never lets an OPEN smuggle a dial target through metadata', async () => {
    const { session, transport } = clientSession();
    const streamPromise = once(session, 'stream');

    transport.deliver(
      raw.open(1, {
        kind: 'http',
        target: '10.0.0.5:22',
        addr: '169.254.169.254',
        port: 22,
        host: 'metadata.internal',
        upstream: 'http://169.254.169.254/latest/meta-data/',
      }),
    );

    const [stream] = (await streamPromise) as [TunnelStream];
    expect(stream.metadata).toEqual({ kind: 'http' });
    expect(JSON.stringify(stream.metadata)).not.toContain('169.254');
  });
});

describe('session — data transfer and half close', () => {
  it('carries bytes in both directions and closes when both sides have ended', async () => {
    const { client, server } = sessionPair();
    const clientStreams = inbound(client);

    const serverStream = server.openStream({ kind: 'http' });
    serverStream.end(Buffer.from('GET / HTTP/1.1\r\n\r\n'));

    await waitFor(() => clientStreams.length === 1, { label: 'inbound stream' });
    const clientStream = clientStreams[0];

    expect((await collect(clientStream)).toString('utf8')).toBe('GET / HTTP/1.1\r\n\r\n');

    // The read side ended; the write side is still open.
    clientStream.end(Buffer.from('HTTP/1.1 200 OK\r\n\r\nhi'));
    expect((await collect(serverStream)).toString('utf8')).toBe('HTTP/1.1 200 OK\r\n\r\nhi');

    await waitFor(() => client.activeStreamCount === 0 && server.activeStreamCount === 0, {
      label: 'both sides free the stream',
    });
  });

  it('lets the peer keep writing after we have half closed', async () => {
    const { client, server } = sessionPair();
    const clientStreams = inbound(client);

    const serverStream = server.openStream();
    await waitFor(() => clientStreams.length === 1, { label: 'inbound stream' });
    const clientStream = clientStreams[0];

    clientStream.end(); // client is done writing, server is not
    const received = deferred<string>();
    clientStream.once('data', (chunk: Buffer) => received.resolve(chunk.toString('utf8')));

    serverStream.write(Buffer.from('still talking'));
    expect(await received.promise).toBe('still talking');
    expect(server.activeStreamCount).toBe(1);
  });

  it('splits a large write into frames no larger than MAX_DATA_PAYLOAD', async () => {
    const { session, transport } = serverSession();
    const stream = session.openStream();
    const payload = Buffer.alloc(200 * 1024, 0x41);

    stream.write(payload);

    await waitFor(() => transport.bytesSentOfType(RawType.DATA) === payload.length, {
      label: 'all data framed',
    });
    const frames = transport.framesOfType(RawType.DATA);
    expect(Math.max(...frames.map((f) => f.payload.length))).toBeLessThanOrEqual(MAX_DATA_PAYLOAD);
    expect(Buffer.concat(frames.map((f) => f.payload)).equals(payload)).toBe(true);
  });
});

describe('session — resets', () => {
  it('aborts both ends, with the code the resetter chose', async () => {
    const { client, server } = sessionPair();
    const clientStreams = inbound(client);

    const serverStream = server.openStream();
    serverStream.on('error', () => undefined);
    await waitFor(() => clientStreams.length === 1, { label: 'inbound stream' });

    // The client could not dial its local target: that is what the server needs
    // to know to render DEBUGG_TUNNEL_UPSTREAM_REFUSED.
    clientStreams[0].reset(ErrorCode.UPSTREAM_UNREACHABLE);

    const [err] = (await once(serverStream, 'error')) as [StreamResetError];
    expect(err).toBeInstanceOf(StreamResetError);
    expect(err.code).toBe(ErrorCode.UPSTREAM_UNREACHABLE);
    expect(err.remote).toBe(true);
    await waitFor(() => client.activeStreamCount === 0 && server.activeStreamCount === 0, {
      label: 'both sides free the stream',
    });
  });

  it('reports an unknown reset code as RESET rather than failing the session', async () => {
    const { session, transport } = clientSession();
    const streams = inbound(session);
    transport.deliver(raw.open(1, { kind: 'http' }));
    await waitFor(() => streams.length === 1, { label: 'inbound stream' });

    const errorPromise = once(streams[0], 'error');
    transport.deliver(raw.rst(1, 0xfffe));

    const [err] = (await errorPromise) as [StreamResetError];
    expect(err.code).toBe(ErrorCode.RESET);
    expect(transport.closedWith).toBeUndefined();
  });

  it('ignores frames for a stream that is already closed — they race with our own RST', async () => {
    const { session, transport } = clientSession();
    const streams = inbound(session);
    transport.deliver(raw.open(1, { kind: 'http' }));
    await waitFor(() => streams.length === 1, { label: 'inbound stream' });

    transport.deliver(raw.rst(1, ErrorCode.RESET));
    await waitFor(() => session.activeStreamCount === 0, { label: 'stream freed' });

    transport.deliver(raw.data(1, 'late bytes'), raw.window(1, 1024), raw.end(1), raw.rst(1, ErrorCode.RESET));

    expect(transport.closedWith).toBeUndefined();
    expect(session.activeStreamCount).toBe(0);
  });

  it('resets a stream that sends DATA after its own END', async () => {
    const { session, transport } = clientSession();
    const streams = inbound(session);
    transport.deliver(raw.open(1, { kind: 'http' }));
    await waitFor(() => streams.length === 1, { label: 'inbound stream' });

    transport.deliver(raw.end(1));
    transport.deliver(raw.data(1, 'after end'));

    await waitFor(() => transport.framesOfType(RawType.RST).length === 1, { label: 'RST sent' });
    expect(transport.framesOfType(RawType.RST)[0]).toMatchObject({
      streamId: 1,
      code: ErrorCode.PROTOCOL_ERROR,
    });
    // Stream-scoped, not session-fatal.
    expect(transport.closedWith).toBeUndefined();
  });
});

describe('session — the concurrent stream cap', () => {
  it('refuses the stream past the cap and keeps the session healthy', async () => {
    const { session, transport } = clientSession();
    const streams = inbound(session);

    for (let id = 1; id <= MAX_CONCURRENT_STREAMS; id++) {
      transport.deliver(raw.open(id, { kind: 'http' }));
    }
    await waitFor(() => streams.length === MAX_CONCURRENT_STREAMS, { label: 'all streams surfaced' });

    transport.deliver(raw.open(MAX_CONCURRENT_STREAMS + 1, { kind: 'http' }));

    await waitFor(() => transport.framesOfType(RawType.RST).length === 1, { label: 'overflow refused' });
    expect(transport.framesOfType(RawType.RST)[0]).toMatchObject({
      streamId: MAX_CONCURRENT_STREAMS + 1,
      code: ErrorCode.REFUSED,
    });
    expect(streams).toHaveLength(MAX_CONCURRENT_STREAMS);
    expect(session.activeStreamCount).toBe(MAX_CONCURRENT_STREAMS);
    expect(transport.closedWith).toBeUndefined();
  });

  it('accepts a new stream once one closes', async () => {
    const { session, transport } = clientSession();
    const streams = inbound(session);
    for (let id = 1; id <= MAX_CONCURRENT_STREAMS; id++) {
      transport.deliver(raw.open(id, { kind: 'http' }));
    }
    await waitFor(() => streams.length === MAX_CONCURRENT_STREAMS, { label: 'all streams surfaced' });

    transport.deliver(raw.rst(1, ErrorCode.RESET));
    await waitFor(() => session.activeStreamCount === MAX_CONCURRENT_STREAMS - 1, { label: 'one freed' });

    transport.deliver(raw.open(MAX_CONCURRENT_STREAMS + 1, { kind: 'http' }));
    await waitFor(() => streams.length === MAX_CONCURRENT_STREAMS + 1, { label: 'replacement accepted' });
    expect(transport.framesOfType(RawType.RST)).toHaveLength(0);
  });

  it('will not open more than the cap locally either', () => {
    const { session } = serverSession();
    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) session.openStream();

    let thrown: unknown;
    try {
      session.openStream();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StreamResetError);
    expect((thrown as StreamResetError).code).toBe(ErrorCode.REFUSED);
  });
});

describe('session — protocol policing', () => {
  /** Every one of these must tear the session down with GOAWAY + close 4004. */
  async function expectFatal(
    setup: (transport: FakeTransport, session: TunnelSession) => void,
    role: 'client' | 'server' = 'client',
  ): Promise<void> {
    const { session, transport } = role === 'client' ? clientSession() : serverSession();
    inbound(session);
    const closed = once(session, 'close');

    setup(transport, session);

    const [info] = (await closed) as [{ closeCode: number }];
    expect(info.closeCode).toBe(CloseCode.PROTOCOL_ERROR);
    const goaway = transport.framesOfType(RawType.GOAWAY);
    expect(goaway).toHaveLength(1);
    expect(goaway[0].code).toBe(ErrorCode.PROTOCOL_ERROR);
    expect(transport.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
  }

  it('fails the session on an OPEN that reuses a stream id', async () => {
    await expectFatal((transport) => {
      transport.deliver(raw.open(2, { kind: 'http' }));
      transport.deliver(raw.open(2, { kind: 'http' }));
    });
  });

  it('fails the session on an OPEN whose id goes backwards', async () => {
    await expectFatal((transport) => {
      transport.deliver(raw.open(5, { kind: 'http' }));
      transport.deliver(raw.open(4, { kind: 'http' }));
    });
  });

  it('fails the session on DATA for a stream that was never opened', async () => {
    await expectFatal((transport) => {
      transport.deliver(raw.data(12, 'nobody opened me'));
    });
  });

  it('fails the session on an undecodable frame', async () => {
    await expectFatal((transport) => {
      transport.deliver(Buffer.from('0b00000001ff', 'hex'));
    });
  });

  it('fails the session on a message that is not a binary frame', async () => {
    await expectFatal((transport) => {
      transport.deliverInvalid('text message');
    });
  });

  it('fails a client session that is sent a PROBE (probes only go client to server)', async () => {
    await expectFatal((transport) => {
      transport.deliver(raw.probe(1, '/health'));
    });
  });

  it('fails a server session that is sent an OPEN (only servers open streams)', async () => {
    await expectFatal((transport) => {
      transport.deliver(raw.open(1, { kind: 'http' }));
    }, 'server');
  });

  it('fails a server session that is sent a PROBE_RESULT', async () => {
    await expectFatal((transport) => {
      transport.deliver(raw.probeResult(1, { status: 200, elapsedMs: 1 }));
    }, 'server');
  });
});
