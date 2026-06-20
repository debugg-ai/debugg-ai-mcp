/**
 * Tool annotation presets (epic p7gft).
 *
 * Annotations are *hints* (MCP 2025-03-26+) that let clients reason about a tool
 * before calling it — e.g. confirm-gate destructive tools, fast-path read-only
 * ones. They are advisory; the server still enforces real safety (deletes also
 * require confirmation via confirmDestructive.ts).
 *
 * Every DebuggAI tool talks to the backend and/or the open web, so
 * `openWorldHint` is true everywhere. `readOnlyHint`/`destructiveHint` reflect a
 * tool's MOST powerful action — the action tools mix reads and writes under one
 * name, so the annotation is the conservative worst case:
 *   - READ_ONLY   : only get/list/probe — never mutates backend state
 *   - WRITES      : can create/update/run (not read-only) but cannot delete
 *   - DESTRUCTIVE : exposes a delete action (irreversible) — clients should confirm
 *
 * Per the spec, `destructiveHint`/`idempotentHint` are only meaningful when
 * `readOnlyHint` is false, so READ_ONLY omits them.
 */

import { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

export const WRITES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};
