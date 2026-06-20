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

/**
 * Build an MCP resource_link content block (MCP 2025-06-18) pointing at an
 * (often presigned) artifact URL — leaner than inlining the bytes, and the URL
 * stays renewable/on-demand. Use for large non-vision artifacts (run-recording
 * GIFs, HAR, console logs) rather than base64-embedding them.
 */
export function resourceLinkBlock(
  uri: string,
  name: string,
  opts: { mimeType?: string; title?: string; description?: string } = {},
) {
  const block: {
    type: 'resource_link';
    uri: string;
    name: string;
    mimeType?: string;
    title?: string;
    description?: string;
  } = { type: 'resource_link', uri, name };
  if (opts.mimeType) block.mimeType = opts.mimeType;
  if (opts.title) block.title = opts.title;
  if (opts.description) block.description = opts.description;
  return block;
}

const MIME_BY_EXT: Record<string, string> = {
  gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm',
  har: 'application/json', json: 'application/json', txt: 'text/plain', log: 'text/plain',
};

function titleize(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bUrl\b|\bUri\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Build resource_link blocks for every (presigned) artifact URL found one level
 * deep in `source` (e.g. an execution's browserSession: HAR, console log, run
 * recording). Defensive about exact field names — it links any https value and
 * skips tunnel/ngrok hosts. Returns [] for nullish/empty input.
 */
export function artifactResourceLinks(
  source: unknown,
): Array<ReturnType<typeof resourceLinkBlock>> {
  if (!source || typeof source !== 'object') return [];
  const out: Array<ReturnType<typeof resourceLinkBlock>> = [];
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (!/^https?:\/\//i.test(value)) continue;
    if (/ngrok|tunnel/i.test(value)) continue;
    const ext = (value.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    const name = ext ? `${key}.${ext}` : key;
    out.push(resourceLinkBlock(value, name, {
      mimeType: MIME_BY_EXT[ext],
      title: titleize(key),
      description: 'Execution artifact (presigned URL — open or fetch on demand).',
    }));
  }
  return out;
}
