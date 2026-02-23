/**
 * Image utility helpers for MCP image content blocks
 */

import axios from 'axios';

/**
 * Fetch an image from a URL and return its base64-encoded data + MIME type.
 * Returns null on any error (image embedding is always best-effort).
 */
export async function fetchImageAsBase64(
  url: string
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 15_000,
      headers: { Accept: 'image/*' },
    });
    const buffer = Buffer.from(response.data);
    const base64 = buffer.toString('base64');
    const rawContentType = (response.headers['content-type'] as string | undefined) ?? '';
    const mimeType = rawContentType.split(';')[0].trim() || inferMimeFromUrl(url);
    return { data: base64, mimeType };
  } catch {
    return null;
  }
}

function inferMimeFromUrl(url: string): string {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

/**
 * Build an MCP image content block from base64 data.
 */
export function imageContentBlock(data: string, mimeType: string) {
  return { type: 'image' as const, data, mimeType };
}
