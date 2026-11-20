/**
 * credentialRef: pass a pointer to a secret instead of the secret.
 *
 * A password given as a tool parameter lands in the model's transcript. A
 * `credentialRef` is resolved HERE, on the machine running the MCP, at call
 * time, and the value only ever travels to the backend run.
 *
 *   env:NAME                   -> process.env.NAME
 *   simpli:<vault-env>/<KEY>   -> `simpli exchange creds -e <vault-env> -f json`[KEY]
 *
 * The resolved value is never logged, returned or put in an error message.
 * resolveCredentialRefs() also hands back the resolved values so the caller can
 * scrub them from whatever the handler returns.
 */

import { execFile } from 'node:child_process';

export const REDACTED_SECRET = '[REDACTED]';

export class CredentialRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialRefError';
  }
}

export type ParsedRef =
  | { kind: 'env'; name: string }
  | { kind: 'simpli'; vaultEnv: string; key: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAULT_ENV = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The MCP's own credentials must never be usable as a login password: a prompt
// that points a ref at them would type them into a page.
const FORBIDDEN_ENV = /^DEBUGGAI_/i;

export function parseCredentialRef(ref: string): ParsedRef {
  const m = /^(env|simpli):(.+)$/.exec(ref.trim());
  if (!m) {
    throw new CredentialRefError(
      `credentialRef must look like 'env:NAME' or 'simpli:<vault-env>/<KEY>' (got a ref with scheme '${ref.split(':')[0].slice(0, 20)}').`,
    );
  }
  const [, scheme, rest] = m;
  if (scheme === 'env') {
    if (!ENV_NAME.test(rest)) throw new CredentialRefError(`credentialRef 'env:' needs a valid variable name, got '${rest.slice(0, 60)}'.`);
    if (FORBIDDEN_ENV.test(rest)) throw new CredentialRefError(`credentialRef cannot point at ${rest}: it is the MCP's own credential.`);
    return { kind: 'env', name: rest };
  }
  const slash = rest.indexOf('/');
  const vaultEnv = slash < 0 ? '' : rest.slice(0, slash);
  const key = slash < 0 ? '' : rest.slice(slash + 1);
  if (!VAULT_ENV.test(vaultEnv) || !ENV_NAME.test(key)) {
    throw new CredentialRefError(`credentialRef 'simpli:' must be 'simpli:<vault-env>/<KEY>', e.g. 'simpli:qa-logins/QA_APP_PASSWORD'.`);
  }
  return { kind: 'simpli', vaultEnv, key };
}

export type ExecJson = (vaultEnv: string) => Promise<Record<string, unknown>>;

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  /** Returns the parsed secrets of one vault environment. Injectable for tests. */
  simpliExchange?: ExecJson;
}

const defaultSimpliExchange: ExecJson = (vaultEnv) =>
  new Promise((resolve, reject) => {
    execFile(
      process.env.SIMPLI_BIN || 'simpli',
      ['exchange', 'creds', '-e', vaultEnv, '-f', 'json'],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        // Never include stdout/stderr: stdout is every secret in the environment.
        if (err) return reject(new CredentialRefError(`could not read vault environment '${vaultEnv}' via the simpli CLI (is it installed and signed in? try \`simpli doctor\`).`));
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed === 'object') return resolve(parsed as Record<string, unknown>);
        } catch { /* fall through */ }
        reject(new CredentialRefError(`the simpli CLI returned unreadable output for vault environment '${vaultEnv}'.`));
      },
    );
  });

/** Resolve one ref to its secret value. */
export async function resolveCredentialRef(ref: string, deps: ResolveDeps = {}, cache = new Map<string, Record<string, unknown>>()): Promise<string> {
  const parsed = parseCredentialRef(ref);
  let value: unknown;
  if (parsed.kind === 'env') {
    value = (deps.env ?? process.env)[parsed.name];
    if (typeof value !== 'string' || value === '') throw new CredentialRefError(`credentialRef 'env:${parsed.name}': that environment variable is not set on the machine running the MCP.`);
  } else {
    let secrets = cache.get(parsed.vaultEnv);
    if (!secrets) {
      secrets = await (deps.simpliExchange ?? defaultSimpliExchange)(parsed.vaultEnv);
      cache.set(parsed.vaultEnv, secrets);
    }
    value = secrets[parsed.key];
    if (typeof value !== 'string' || value === '') throw new CredentialRefError(`credentialRef 'simpli:${parsed.vaultEnv}/${parsed.key}': no such secret in that vault environment.`);
  }
  return value as string;
}

/**
 * Walk a validated tool input; every object carrying `credentialRef` gets its
 * `password` set to the resolved value and the ref removed. Returns a new input
 * plus the resolved values (for scrubbing output).
 */
export async function resolveCredentialRefs<T>(input: T, deps: ResolveDeps = {}): Promise<{ input: T; secrets: string[] }> {
  const secrets = new Set<string>();
  const cache = new Map<string, Record<string, unknown>>();
  const walk = async (v: unknown): Promise<unknown> => {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) out.push(await walk(x));
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'credentialRef' && typeof x === 'string') continue;
        out[k] = await walk(x);
      }
      const ref = (v as Record<string, unknown>).credentialRef;
      if (typeof ref === 'string') {
        const secret = await resolveCredentialRef(ref, deps, cache);
        secrets.add(secret);
        out.password = secret;
      }
      return out;
    }
    return v;
  };
  const resolved = (await walk(input)) as T;
  return { input: resolved, secrets: [...secrets] };
}

export function hasCredentialRef(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasCredentialRef);
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => (k === 'credentialRef' && typeof x === 'string') || hasCredentialRef(x));
  }
  return false;
}

/** Replace every occurrence of any secret in any string within `value`. */
export function scrubSecrets<T>(value: T, secrets: string[]): T {
  const live = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  if (live.length === 0) return value;
  const scrubStr = (s: string): string => {
    let out = s;
    for (const secret of live) out = out.split(secret).join(REDACTED_SECRET);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubStr(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[scrubStr(k)] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
