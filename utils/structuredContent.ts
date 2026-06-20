/**
 * Structured tool output (epic 3eb5l).
 *
 * MCP 2025-06-18 added `structuredContent` on tool results: a machine-readable
 * JSON object that mirrors the human-readable text block. Clients that support
 * it consume parsed data directly instead of re-parsing the text blob; the text
 * block stays for back-compat.
 *
 * Every leaf handler already returns its payload as `JSON.stringify(payload)` in
 * a single text item, so rather than touch ~20 handlers we promote it in ONE
 * place — the CallTool path in index.ts wraps each result with this helper.
 *
 * We intentionally do NOT declare `outputSchema` on the tools: the action tools
 * return polymorphic shapes per action, a faithful schema would need top-level
 * `oneOf` (which the Anthropic API rejects, same as input schemas), and a
 * permissive `type:object` schema adds no value. `structuredContent` without a
 * declared schema is spec-valid and is the actual win.
 */

import { ToolResponse } from '../types/index.js';

/**
 * Attach `structuredContent` to a successful tool result when its single text
 * block is a JSON object. No-op for errors, multi-text results, non-object
 * payloads, or results that already set structuredContent.
 */
export function withStructuredContent(result: ToolResponse): ToolResponse {
  if (!result || result.isError || result.structuredContent) return result;

  const textItems = (result.content || []).filter(
    (c) => c.type === 'text' && typeof c.text === 'string',
  );
  if (textItems.length !== 1) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(textItems[0].text as string);
  } catch {
    return result; // not JSON (shouldn't happen for our handlers) — leave as-is
  }

  // Spec requires structuredContent to be a JSON object (not array/primitive/null).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result;
  }

  return { ...result, structuredContent: parsed as Record<string, unknown> };
}
