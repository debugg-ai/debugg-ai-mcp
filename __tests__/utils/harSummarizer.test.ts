/**
 * harSummarizer pure-function tests — Phase 2.1 of /feature-lifecycle probe-page.
 *
 * Aggregation key contract: `origin + pathname` (per system reqs pe5c).
 * MUST FAIL until 4.1 ships — stub throws.
 */

import { summarizeHar, summarizeConsole } from '../../utils/harSummarizer.js';

// ── Shared HAR entry fixture builder ────────────────────────────────────────
function harEntry(opts: {
  url: string;
  status?: number;
  bytes?: number;
  mimeType?: string;
}): any {
  return {
    request: { method: 'GET', url: opts.url, headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
    response: {
      status: opts.status ?? 200,
      statusText: '',
      headers: [],
      cookies: [],
      content: { size: opts.bytes ?? 100, mimeType: opts.mimeType ?? 'text/html' },
      redirectURL: '',
      headersSize: -1,
      bodySize: opts.bytes ?? 100,
    },
    cache: {},
    timings: { send: 0, wait: 50, receive: 10 },
  };
}

describe('summarizeHar', () => {
  test('empty entries → empty summary', () => {
    expect(summarizeHar([])).toEqual([]);
  });

  test('single entry → one summary row with count=1', () => {
    const result = summarizeHar([harEntry({ url: 'https://example.com/' })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      url: 'https://example.com/',
      count: 1,
      statuses: { '200': 1 },
      totalBytes: 100,
      mimeType: 'text/html',
    });
  });

  test('refetch loop: 5 GETs to same path with different query strings → ONE row, count=5', () => {
    // The original client-feedback #1 use case. Aggregation key is
    // origin + pathname, so ?n=0..4 collapse together.
    const entries = [0, 1, 2, 3, 4].map(n => harEntry({ url: `https://example.com/api/poll?n=${n}` }));
    const result = summarizeHar(entries);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      url: 'https://example.com/api/poll',
      count: 5,
      statuses: { '200': 5 },
      totalBytes: 500,
    });
  });

  test('different paths → separate rows', () => {
    const entries = [
      harEntry({ url: 'https://example.com/api/users' }),
      harEntry({ url: 'https://example.com/api/orders' }),
    ];
    const result = summarizeHar(entries);
    expect(result).toHaveLength(2);
    const urls = result.map(r => r.url).sort();
    expect(urls).toEqual(['https://example.com/api/orders', 'https://example.com/api/users']);
  });

  test('different origins, same path → separate rows (no cross-origin collapse)', () => {
    const entries = [
      harEntry({ url: 'https://example.com/api/users' }),
      harEntry({ url: 'https://other.com/api/users' }),
    ];
    const result = summarizeHar(entries);
    expect(result).toHaveLength(2);
  });

  test('mixed status codes → statusDistribution counts each', () => {
    const entries = [
      harEntry({ url: 'https://example.com/api/x', status: 200 }),
      harEntry({ url: 'https://example.com/api/x', status: 200 }),
      harEntry({ url: 'https://example.com/api/x', status: 404 }),
      harEntry({ url: 'https://example.com/api/x', status: 500 }),
    ];
    const result = summarizeHar(entries);
    expect(result).toHaveLength(1);
    expect(result[0].statuses).toEqual({ '200': 2, '404': 1, '500': 1 });
    expect(result[0].count).toBe(4);
  });

  test('totalBytes sums response.content.size across entries', () => {
    const entries = [
      harEntry({ url: 'https://example.com/big', bytes: 1000 }),
      harEntry({ url: 'https://example.com/big', bytes: 2500 }),
    ];
    const result = summarizeHar(entries);
    expect(result[0].totalBytes).toBe(3500);
  });

  test('homogeneous mimeType → preserved', () => {
    const entries = [
      harEntry({ url: 'https://example.com/data', mimeType: 'application/json' }),
      harEntry({ url: 'https://example.com/data', mimeType: 'application/json' }),
    ];
    const result = summarizeHar(entries);
    expect(result[0].mimeType).toBe('application/json');
  });

  test('mixed mimeTypes for same key → mimeType absent', () => {
    const entries = [
      harEntry({ url: 'https://example.com/x', mimeType: 'text/html' }),
      harEntry({ url: 'https://example.com/x', mimeType: 'application/json' }),
    ];
    const result = summarizeHar(entries);
    expect(result[0]).not.toHaveProperty('mimeType');
  });

  test('sorted descending by count (hottest endpoints first)', () => {
    const entries = [
      harEntry({ url: 'https://example.com/once' }),
      ...Array.from({ length: 5 }, () => harEntry({ url: 'https://example.com/many' })),
      harEntry({ url: 'https://example.com/twice' }),
      harEntry({ url: 'https://example.com/twice' }),
    ];
    const result = summarizeHar(entries);
    expect(result.map(r => r.url)).toEqual([
      'https://example.com/many',
      'https://example.com/twice',
      'https://example.com/once',
    ]);
  });

  test('malformed entry (missing response) → skipped, not thrown', () => {
    const entries = [
      { request: { url: 'https://example.com/' } }, // malformed
      harEntry({ url: 'https://example.com/api/x' }),
    ];
    const result = summarizeHar(entries);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/api/x');
  });
});

describe('summarizeConsole', () => {
  test('empty → empty', () => {
    expect(summarizeConsole([])).toEqual([]);
  });

  test('passes through level, text, source, lineNumber, timestamp', () => {
    const result = summarizeConsole([
      { level: 'error', text: 'ReferenceError: x is undefined', url: 'https://example.com/app.js', line_number: 42, timestamp: 1234567890 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      level: 'error',
      text: 'ReferenceError: x is undefined',
      source: 'https://example.com/app.js',
      lineNumber: 42,
      timestamp: 1234567890,
    });
  });

  test('preserves all log levels (log/info/warn/error/debug)', () => {
    const result = summarizeConsole([
      { level: 'log', text: 'a' },
      { level: 'info', text: 'b' },
      { level: 'warning', text: 'c' },
      { level: 'error', text: 'd' },
      { level: 'debug', text: 'e' },
    ]);
    expect(result).toHaveLength(5);
    expect(result.map(r => r.level)).toEqual(['log', 'info', 'warning', 'error', 'debug']);
  });

  test('omitted url/line_number → undefined source/lineNumber', () => {
    const result = summarizeConsole([{ level: 'log', text: 'hi' }]);
    expect(result[0].source).toBeUndefined();
    expect(result[0].lineNumber).toBeUndefined();
  });
});
