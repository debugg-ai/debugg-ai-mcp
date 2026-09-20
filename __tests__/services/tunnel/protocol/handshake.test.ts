/**
 * Websocket handshake — debugg tunnel wire protocol v1.
 * Bead debugg_ai_mcp-xkoh.1.3 (2.1). Spec: bead debugg_ai_mcp-xkoh.1.2 §1.
 *
 * The handshake is where a version mismatch has to be survivable: the client and
 * the tunnel server ship from different repos on different schedules, so "the
 * server refuses politely and says what it speaks" is a hard requirement, not a
 * nicety.
 */

import {
  buildHandshakeHeaders,
  negotiateProtocolVersion,
  validateHandshakeRequest,
  interpretHandshakeResponse,
} from '../../../../services/tunnel/protocol/handshake.js';
import { PROTOCOL_VERSION } from '../../../../services/tunnel/protocol/constants.js';
import { runConformanceVectors } from '../../../../services/tunnel/protocol/conformance.js';
import { loadVectorFile, type HandshakeVector } from './helpers.js';

interface HandshakeVectorFile {
  supported: number[];
  vectors: HandshakeVector[];
}

const handshakeVectors = loadVectorFile<HandshakeVectorFile>('handshake.json');

describe('handshake — request headers', () => {
  it('builds exactly the headers the server expects', () => {
    expect(
      buildHandshakeHeaders({
        tunnelId: '3f1c8a12-1f0e-4a5b-9d33-2a6f0b7c4e11',
        tunnelKey: 'tk_live_9f3a',
        clientVersion: 'debugg-ai-mcp/4.3.0',
      }),
    ).toEqual({
      Authorization: 'Bearer tk_live_9f3a',
      'X-Debugg-Tunnel-Id': '3f1c8a12-1f0e-4a5b-9d33-2a6f0b7c4e11',
      'X-Debugg-Tunnel-Protocol': '1',
      'X-Debugg-Tunnel-Client-Version': 'debugg-ai-mcp/4.3.0',
    });
  });

  it('omits the client version when there isn\'t one', () => {
    const headers = buildHandshakeHeaders({ tunnelId: 'abc123', tunnelKey: 'k' });
    expect(headers['X-Debugg-Tunnel-Client-Version']).toBeUndefined();
    expect(headers['X-Debugg-Tunnel-Protocol']).toBe(String(PROTOCOL_VERSION));
  });

  it('offers several versions, best first', () => {
    const headers = buildHandshakeHeaders({ tunnelId: 'abc123', tunnelKey: 'k', versions: [2, 1] });
    expect(headers['X-Debugg-Tunnel-Protocol']).toBe('2, 1');
  });

  it('never puts the key anywhere but the Authorization header', () => {
    const headers = buildHandshakeHeaders({ tunnelId: 'abc123', tunnelKey: 'sup3rs3cret' });
    const leaked = Object.entries(headers).filter(
      ([name, value]) => name !== 'Authorization' && value.includes('sup3rs3cret'),
    );
    expect(leaked).toEqual([]);
  });
});

describe('handshake — version negotiation', () => {
  it.each([
    ['1', 1],
    ['2, 1', 1],
    ['  3 ,  1  ', 1],
    ['1,1', 1],
  ])('negotiates %s to %s', (offered, expected) => {
    expect(negotiateProtocolVersion(offered as string)).toBe(expected);
  });

  it.each([['2'], ['v1'], [''], ['0'], ['1.5'], ['-1']])('refuses %s', (offered) => {
    expect(negotiateProtocolVersion(offered as string)).toBeNull();
  });

  it('refuses a missing header', () => {
    expect(negotiateProtocolVersion(undefined)).toBeNull();
  });

  it('handles a repeated header, which node delivers as an array', () => {
    expect(negotiateProtocolVersion(['2', '1'])).toBe(1);
  });

  it('picks the highest version both ends speak', () => {
    expect(negotiateProtocolVersion('1, 2, 3', [1, 2])).toBe(2);
  });
});

describe('handshake — server side validation (conformance vectors)', () => {
  it.each(handshakeVectors.vectors)('$name', (v) => {
    const result = validateHandshakeRequest(v.requestHeaders, handshakeVectors.supported);
    expect(result).toEqual(v.expect);
  });

  it('rejects an unsupported version before it even looks at the token', () => {
    const result = validateHandshakeRequest({
      authorization: 'Bearer definitely-not-a-real-key',
      'x-debugg-tunnel-id': 'abc123',
      'x-debugg-tunnel-protocol': '99',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(426);
    expect(result.responseHeaders['X-Debugg-Tunnel-Supported']).toBe('1');
    expect(result.body).toEqual({ error: 'UNSUPPORTED_PROTOCOL_VERSION', supported: [1] });
  });
});

describe('handshake — the conformance runner agrees', () => {
  it('reports no handshake failures for this build', () => {
    expect(
      runConformanceVectors({
        frames: { vectors: [] },
        invalidFrames: { vectors: [] },
        handshake: handshakeVectors,
      }),
    ).toEqual([]);
  });
});

describe('handshake — client side interpretation of the response', () => {
  it('accepts a 101 whose version echo is one we offered', () => {
    expect(interpretHandshakeResponse(101, { 'x-debugg-tunnel-protocol': '1' })).toEqual({ ok: true, version: 1 });
  });

  it('refuses a 101 with no version echo', () => {
    const result = interpretHandshakeResponse(101, {});
    expect(result.ok).toBe(false);
  });

  it('refuses a 101 that echoes a version we never offered', () => {
    const result = interpretHandshakeResponse(101, { 'x-debugg-tunnel-protocol': '7' });
    expect(result.ok).toBe(false);
  });

  it('reports a 426 as terminal, with the versions the server does speak', () => {
    const result = interpretHandshakeResponse(426, { 'x-debugg-tunnel-supported': '2, 3' });
    expect(result).toEqual({ ok: false, status: 426, supported: [2, 3], retryable: false });
  });

  it.each([[400], [401], [403], [426]])('treats %s as not retryable — the same token will fail again', (status) => {
    const result = interpretHandshakeResponse(status as number, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.retryable).toBe(false);
  });

  it.each([[429], [500], [502], [503]])('treats %s as retryable', (status) => {
    const result = interpretHandshakeResponse(status as number, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.retryable).toBe(true);
  });
});
