/**
 * Wire types for the local click-through executor (docs/local-click-through-design-2026-11-12.md).
 * The cloud brain sends Actions; the executor returns StepResults. `ref` indexes the
 * element list of the LAST observation only.
 */
export const PROTOCOL_VERSION = 1;

export type Action =
  | { type: 'navigate'; url: string }
  | { type: 'click'; ref: number; button?: 'left' | 'right' | 'middle'; doubleClick?: boolean }
  | { type: 'type'; ref: number; text: string; submit?: boolean; clear?: boolean }
  | { type: 'press'; key: string }
  | { type: 'select'; ref: number; value?: string; label?: string }
  | { type: 'hover'; ref: number }
  | { type: 'scroll'; ref?: number; direction?: 'up' | 'down'; amount?: number }
  | { type: 'wait'; ms?: number; forText?: string; forRef?: number; timeoutMs?: number }
  | { type: 'back' }
  | { type: 'reload' }
  | { type: 'observe' };

export type ActionErrorCode =
  | 'NOT_FOUND' | 'NOT_VISIBLE' | 'STALE_REF' | 'NAV_BLOCKED' | 'TIMEOUT' | 'BAD_ACTION' | 'FAILED';

export interface ActionResult {
  ok: boolean;
  error?: { code: ActionErrorCode; message: string };
}

export interface ElementInfo {
  ref: number;
  tag: string;
  role: string;
  name: string;
  text: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  box: { x: number; y: number; w: number; h: number };
}

export interface Observation {
  url: string;
  title: string;
  elements: ElementInfo[];
  /** Visible page text, truncated. */
  text: string;
  screenshotBase64?: string;
  screenshotMime?: 'image/jpeg';
  /** Console errors/warnings and failed requests since the previous observation. */
  delta: {
    console: Array<{ level: string; text: string }>;
    failedRequests: Array<{ url: string; status: number | 'aborted' }>;
    dialogs: Array<{ type: string; message: string }>;
  };
}

export interface StepResult {
  actionResult: ActionResult;
  observation: Observation;
}
