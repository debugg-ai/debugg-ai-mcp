/**
 * Tests for utils/imageUtils.ts
 *
 * Covers:
 *  - fetchImageAsBase64: success, charset stripping, MIME inference, error cases
 *  - imageContentBlock: correct shape
 */

import { jest } from '@jest/globals';

// Mock axios before importing the module under test
const mockAxiosGet = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('axios', () => ({
  default: { get: mockAxiosGet },
}));

const { fetchImageAsBase64, imageContentBlock } = await import('../../utils/imageUtils.js');

beforeEach(() => {
  jest.clearAllMocks();
});

// ── fetchImageAsBase64 ───────────────────────────────────────────────────────

describe('fetchImageAsBase64', () => {
  function makeAxiosResponse(data: ArrayBuffer, contentType?: string) {
    const headers: Record<string, string> = {};
    if (contentType !== undefined) {
      headers['content-type'] = contentType;
    }
    return { data, headers };
  }

  test('success: returns base64 data and mimeType from Content-Type header', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    mockAxiosGet.mockResolvedValueOnce(
      makeAxiosResponse(bytes.buffer, 'image/png')
    );

    const result = await fetchImageAsBase64('https://example.com/img.png');
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/png');
    expect(typeof result!.data).toBe('string');
    // Verify base64 round-trip
    const decoded = Buffer.from(result!.data, 'base64');
    expect(decoded[0]).toBe(0x89);
  });

  test('strips charset from Content-Type', async () => {
    const bytes = new Uint8Array([0xff, 0xd8]);
    mockAxiosGet.mockResolvedValueOnce(
      makeAxiosResponse(bytes.buffer, 'image/jpeg; charset=utf-8')
    );

    const result = await fetchImageAsBase64('https://example.com/photo.jpg');
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/jpeg');
  });

  test('infers MIME from URL extension when no Content-Type header', async () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46]); // GIF magic
    mockAxiosGet.mockResolvedValueOnce(
      makeAxiosResponse(bytes.buffer, undefined)
    );

    const result = await fetchImageAsBase64('https://example.com/anim.gif');
    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/gif');
  });

  test('infers image/jpeg for .jpg extension', async () => {
    const bytes = new Uint8Array([1]);
    mockAxiosGet.mockResolvedValueOnce(makeAxiosResponse(bytes.buffer, ''));

    const result = await fetchImageAsBase64('https://example.com/photo.jpg');
    expect(result!.mimeType).toBe('image/jpeg');
  });

  test('infers image/jpeg for .jpeg extension', async () => {
    const bytes = new Uint8Array([1]);
    mockAxiosGet.mockResolvedValueOnce(makeAxiosResponse(bytes.buffer, ''));

    const result = await fetchImageAsBase64('https://example.com/photo.jpeg');
    expect(result!.mimeType).toBe('image/jpeg');
  });

  test('infers image/webp for .webp extension', async () => {
    const bytes = new Uint8Array([1]);
    mockAxiosGet.mockResolvedValueOnce(makeAxiosResponse(bytes.buffer, ''));

    const result = await fetchImageAsBase64('https://example.com/photo.webp');
    expect(result!.mimeType).toBe('image/webp');
  });

  test('falls back to image/png for unknown extension', async () => {
    const bytes = new Uint8Array([1]);
    mockAxiosGet.mockResolvedValueOnce(makeAxiosResponse(bytes.buffer, ''));

    const result = await fetchImageAsBase64('https://example.com/image.bmp');
    expect(result!.mimeType).toBe('image/png');
  });

  test('returns null when axios throws (network error)', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('Network Error'));

    const result = await fetchImageAsBase64('https://example.com/img.png');
    expect(result).toBeNull();
  });

  test('returns null when axios throws (404-like error)', async () => {
    const err = Object.assign(new Error('Request failed'), {
      response: { status: 404 },
    });
    mockAxiosGet.mockRejectedValueOnce(err);

    const result = await fetchImageAsBase64('https://example.com/missing.png');
    expect(result).toBeNull();
  });

  test('strips query params when inferring MIME from URL', async () => {
    const bytes = new Uint8Array([1]);
    mockAxiosGet.mockResolvedValueOnce(makeAxiosResponse(bytes.buffer, ''));

    const result = await fetchImageAsBase64('https://example.com/photo.gif?w=100&h=100');
    expect(result!.mimeType).toBe('image/gif');
  });
});

// ── imageContentBlock ────────────────────────────────────────────────────────

describe('imageContentBlock', () => {
  test('returns correct MCP image content block shape', () => {
    const block = imageContentBlock('base64data', 'image/png');
    expect(block).toEqual({
      type: 'image',
      data: 'base64data',
      mimeType: 'image/png',
    });
  });

  test('type is the literal string "image"', () => {
    const block = imageContentBlock('x', 'image/jpeg');
    expect(block.type).toBe('image');
  });
});
