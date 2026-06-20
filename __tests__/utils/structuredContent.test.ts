/**
 * withStructuredContent — promote a JSON text payload to structuredContent
 * (epic 3eb5l). Mirrors what the CallTool path does to every successful result.
 */

import { withStructuredContent } from '../../utils/structuredContent.js';
import { ToolResponse } from '../../types/index.js';

const textResult = (obj: unknown): ToolResponse => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});

describe('withStructuredContent', () => {
  test('attaches structuredContent mirroring a single JSON-object text block', () => {
    const payload = { projects: [{ uuid: 'p1' }], pagination: { page: 1 } };
    const out = withStructuredContent(textResult(payload));
    expect(out.structuredContent).toEqual(payload);
    // text block is preserved for back-compat
    expect(out.content[0].text).toBe(JSON.stringify(payload));
  });

  test('keeps an image item alongside the single text block (e.g. probe_page)', () => {
    const payload = { results: [{ url: 'https://x', statusCode: 200 }] };
    const out = withStructuredContent({
      content: [
        { type: 'text', text: JSON.stringify(payload) },
        { type: 'image', data: 'base64==', mimeType: 'image/png' },
      ],
    });
    expect(out.structuredContent).toEqual(payload);
  });

  test('no-op for error results', () => {
    const out = withStructuredContent({ ...textResult({ error: 'boom' }), isError: true });
    expect(out.structuredContent).toBeUndefined();
  });

  test('no-op when payload is a JSON array (spec requires an object)', () => {
    const out = withStructuredContent(textResult([1, 2, 3]));
    expect(out.structuredContent).toBeUndefined();
  });

  test('no-op when the text is not JSON', () => {
    const out = withStructuredContent({ content: [{ type: 'text', text: 'plain text' }] });
    expect(out.structuredContent).toBeUndefined();
  });

  test('no-op when there are multiple text blocks (ambiguous)', () => {
    const out = withStructuredContent({
      content: [
        { type: 'text', text: JSON.stringify({ a: 1 }) },
        { type: 'text', text: JSON.stringify({ b: 2 }) },
      ],
    });
    expect(out.structuredContent).toBeUndefined();
  });

  test('does not overwrite an already-set structuredContent', () => {
    const out = withStructuredContent({
      content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }],
      structuredContent: { preset: true },
    });
    expect(out.structuredContent).toEqual({ preset: true });
  });
});
