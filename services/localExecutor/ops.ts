/**
 * Wire types for the Browser Executor API v1 (sentinal docs/local-executor-api-design.md).
 * The cloud brain's page calls arrive as Commands; this side answers with Results.
 */
export const API_VERSION = 1;

export const OPS = [
  'goto', 'back', 'forward', 'reload', 'evaluate',
  'click', 'dblclick', 'fill', 'type', 'press', 'hover', 'select_option', 'check', 'uncheck', 'focus', 'scroll',
  'wait_for_selector', 'wait_for_load_state', 'wait_for_function',
  'query', 'query_all', 'screenshot', 'content', 'set_content', 'add_init_script', 'title', 'url', 'set_viewport',
  'new_page', 'list_pages', 'switch_page', 'close_page',
] as const;
export type OpName = typeof OPS[number];

export interface CommandTarget { selector?: string; frame?: string[] | null; page_id?: string | null }

export interface Command {
  id: string;
  seq: number;
  op: OpName | string;
  target?: CommandTarget;
  args?: Record<string, unknown>;
  deadline_ms?: number;
  idempotency_key?: string;
  upload_url?: string;
  upload_content_type?: 'image/png' | 'image/jpeg';
}

export type ErrorCode =
  | 'target_not_found' | 'not_visible' | 'timeout' | 'navigation_failed' | 'domain_blocked'
  | 'unsupported_op' | 'invalid_args' | 'browser_crashed' | 'executor_busy' | 'cancelled' | 'internal';

export interface ExecError { code: ErrorCode; message: string; retryable: boolean; detail?: Record<string, unknown> }

/** Things that happened since the previous result (the brain cannot subscribe to page events). */
export type ExecEvent = { ts: number } & (
  | { type: 'console'; level: string; text: string }
  | { type: 'request_failed'; url: string; status: number | 'aborted' }
  | { type: 'dialog'; dialog: string; message: string }
  | { type: 'popup'; page_id: string; url: string }
  | { type: 'download'; url: string; filename: string }
);

export interface Observation {
  kind: 'action' | 'query' | 'screenshot' | 'content' | 'eval';
  value?: unknown;
  screenshot_ref?: string | null;
}

export interface CommandResult {
  command_id: string;
  ok: boolean;
  url?: string;
  title?: string;
  duration_ms: number;
  observation?: Observation;
  events?: ExecEvent[];
  error?: ExecError;
}

export interface SessionLimits {
  heartbeat_s: number;
  lease_s: number;
  max_inline_bytes: number;
  max_batch: number;
  /** Commands run at once. Unset = no artificial cap (the brain's own ordering decides). */
  max_inflight?: number;
  max_steps?: number;
  session_ttl_s?: number;
}
