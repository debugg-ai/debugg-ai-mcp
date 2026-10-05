/**
 * platform-98fv.25: the relay never passes a run secret on.
 *
 * The backend used to persist the password a check_app_in_browser run was given
 * and serve it back in `contextData.env.password`, `state.env.password` and every
 * node payload. The backend now seals it at rest and redacts it on read; this is
 * the relay's own copy of that rule, so an older or misbehaving backend still
 * cannot leak through the MCP.
 *
 * Deliberately narrow and exact (mirrors sentinal `run_secrets.redact_run_secrets`):
 *   - any non-empty string under a key named exactly `password` / `passwd`;
 *   - every string value of a `projectSecrets` / `project_secrets` mapping;
 *   - any string carrying the backend's sealed-value prefix.
 * Identifiers such as `browserSessionId` / `resolvedCredentialId` are untouched.
 */

export const REDACTED = '[REDACTED]';
const SEALED_PREFIX = 'sealed:v1:';
const SECRET_KEYS = new Set(['password', 'passwd']);
const SECRET_MAPPING_KEYS = new Set(['projectSecrets', 'project_secrets']);

function isSealed(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(SEALED_PREFIX);
}

export function redactRunSecrets<T>(value: T, inMapping = false): T {
  if (Array.isArray(value)) {
    return value.map((v) => (isSealed(v) ? REDACTED : redactRunSecrets(v))) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && v && (inMapping || SECRET_KEYS.has(k) || isSealed(v))) {
        out[k] = REDACTED;
      } else {
        out[k] = redactRunSecrets(v, SECRET_MAPPING_KEYS.has(k));
      }
    }
    return out as T;
  }
  return value;
}
