import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCredentialRef, resolveCredentialRef, resolveCredentialRefs, scrubSecrets, hasCredentialRef, CredentialRefError,
} from '../../utils/credentialRef.js';
import { TestPageChangesInputSchema, TriggerCrawlInputSchema, CreateEnvironmentInputSchema, UpdateEnvironmentInputSchema } from '../../types/index.js';
import { createErrorResponse } from '../../utils/errors.js';

const SECRET = 'S3cr3t-Pa55word-xyz789';

describe('parseCredentialRef', () => {
  test('accepts env and simpli refs', () => {
    expect(parseCredentialRef('env:MY_PW')).toEqual({ kind: 'env', name: 'MY_PW' });
    expect(parseCredentialRef('simpli:qa-logins/QA_TANDEM_PASSWORD')).toEqual({ kind: 'simpli', vaultEnv: 'qa-logins', key: 'QA_TANDEM_PASSWORD' });
  });
  test.each(['nope', 'file:/etc/passwd', 'env:', 'env:bad name', 'simpli:qa-logins', 'simpli:/KEY', 'simpli:a/b c', 'env:DEBUGGAI_API_KEY', 'env:debuggai_api_key'])('rejects %s', (r) => {
    expect(() => parseCredentialRef(r)).toThrow(CredentialRefError);
  });
});

describe('resolveCredentialRef', () => {
  test('env', async () => {
    expect(await resolveCredentialRef('env:PW', { env: { PW: SECRET } })).toBe(SECRET);
  });
  test('missing env var errors without a value', async () => {
    await expect(resolveCredentialRef('env:PW', { env: {} })).rejects.toThrow(/not set/);
  });
  test('simpli reads one vault env once per call and picks the key', async () => {
    const ex = jest.fn(async (_e: string) => ({ A: 'x', B: SECRET }));
    const { input, secrets } = await resolveCredentialRefs(
      { loginCredentials: [{ username: 'a', credentialRef: 'simpli:v/A' }, { username: 'b', credentialRef: 'simpli:v/B' }] },
      { simpliExchange: ex },
    );
    expect(ex).toHaveBeenCalledTimes(1);
    expect(input.loginCredentials.map((c: any) => c.password)).toEqual(['x', SECRET]);
    expect(JSON.stringify(input)).not.toContain('credentialRef');
    expect(secrets.sort()).toEqual(['x', SECRET].sort());
  });
  test('unknown simpli key error does not list the other secrets', async () => {
    const err: any = await resolveCredentialRef('simpli:v/NOPE', { simpliExchange: async () => ({ B: SECRET }) }).catch(e => e);
    expect(err).toBeInstanceOf(CredentialRefError);
    expect(err.message).not.toContain(SECRET);
  });
});

describe('default simpli CLI path (fake binary)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credref-'));
  const okBin = join(dir, 'simpli-ok');
  const badBin = join(dir, 'simpli-bad');
  writeFileSync(okBin, `#!/bin/sh\necho '{"QA_PW":"${SECRET}"}'\n`); chmodSync(okBin, 0o755);
  writeFileSync(badBin, `#!/bin/sh\necho '{"QA_PW":"${SECRET}"}'; echo boom >&2; exit 3\n`); chmodSync(badBin, 0o755);
  const old = process.env.SIMPLI_BIN;
  afterAll(() => { if (old === undefined) delete process.env.SIMPLI_BIN; else process.env.SIMPLI_BIN = old; });

  test('resolves through the CLI', async () => {
    process.env.SIMPLI_BIN = okBin;
    expect(await resolveCredentialRef('simpli:qa-logins/QA_PW')).toBe(SECRET);
  });
  test('CLI failure never surfaces its stdout', async () => {
    process.env.SIMPLI_BIN = badBin;
    const err: any = await resolveCredentialRef('simpli:qa-logins/QA_PW').catch(e => e);
    expect(err).toBeInstanceOf(CredentialRefError);
    expect(err.message).not.toContain(SECRET);
  });
});

describe('schemas accept credentialRef', () => {
  const base = { description: 'd', url: 'https://example.com' };
  test('check_app_in_browser top-level, auth and loginCredentials', () => {
    expect(() => TestPageChangesInputSchema.parse({ ...base, username: 'u', credentialRef: 'env:X' })).not.toThrow();
    expect(() => TestPageChangesInputSchema.parse({ ...base, auth: { username: 'u', credentialRef: 'env:X' } })).not.toThrow();
    expect(() => TestPageChangesInputSchema.parse({ ...base, loginCredentials: [{ username: 'u', credentialRef: 'env:X' }] })).not.toThrow();
  });
  test('loginCredentials needs exactly one of password / credentialRef', () => {
    expect(() => TestPageChangesInputSchema.parse({ ...base, loginCredentials: [{ username: 'u' }] })).toThrow();
    expect(() => TestPageChangesInputSchema.parse({ ...base, loginCredentials: [{ username: 'u', password: 'p', credentialRef: 'env:X' }] })).toThrow();
  });
  test('trigger_crawl and environment add/update', () => {
    expect(() => TriggerCrawlInputSchema.parse({ url: 'https://example.com', username: 'u', credentialRef: 'env:X' })).not.toThrow();
    expect(() => CreateEnvironmentInputSchema.parse({ name: 'n', url: 'https://e.com', credentials: [{ label: 'l', username: 'u', credentialRef: 'env:X' }] })).not.toThrow();
    expect(() => CreateEnvironmentInputSchema.parse({ name: 'n', url: 'https://e.com', credentials: [{ label: 'l', username: 'u' }] })).toThrow();
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    expect(() => UpdateEnvironmentInputSchema.parse({ uuid, addCredentials: [{ label: 'l', username: 'u', credentialRef: 'env:X' }] })).not.toThrow();
    expect(() => UpdateEnvironmentInputSchema.parse({ uuid, updateCredentials: [{ uuid, credentialRef: 'env:X' }] })).not.toThrow();
    expect(() => UpdateEnvironmentInputSchema.parse({ uuid, updateCredentials: [{ uuid, password: 'p', credentialRef: 'env:X' }] })).toThrow();
  });
});

describe('the resolved secret never appears in any output or log', () => {
  test('resolve → handler echo/error → scrub; hasCredentialRef detects', async () => {
    const raw = { username: 'u', credentialRef: 'env:PW', auth: { username: 'u', credentialRef: 'env:PW' } };
    expect(hasCredentialRef(raw)).toBe(true);
    const { input, secrets } = await resolveCredentialRefs(raw, { env: { PW: SECRET } });
    expect((input as any).password).toBe(SECRET);
    expect((input as any).auth.password).toBe(SECRET);

    // A careless handler that echoes the password in a result and in an error.
    const result = { content: [{ type: 'text', text: `typed ${SECRET} into form` }], extra: { [`k-${SECRET}`]: [SECRET] } };
    const errResp = createErrorResponse(new Error(`login failed for password ${SECRET}`), 'check_app_in_browser');
    const out = JSON.stringify([scrubSecrets(result, secrets), scrubSecrets(errResp, secrets)]);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]');
  });

  test('error log payload is clean after scrubSecrets (the index.ts catch path)', async () => {
    const { secrets } = await resolveCredentialRefs({ credentialRef: 'env:PW' }, { env: { PW: SECRET } });
    const payload = scrubSecrets({ errorCode: 1, message: `upstream said bad password ${SECRET}`, data: { echoed: SECRET } }, secrets);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  test('resolution errors carry the ref, never any value', async () => {
    const errs = await Promise.all([
      resolveCredentialRef('simpli:nope', { env: { PW: SECRET } }).catch(x => x),
      resolveCredentialRef('env:MISSING', { env: { PW: SECRET } }).catch(x => x),
      resolveCredentialRef('simpli:v/MISSING', { simpliExchange: async () => ({ PW: SECRET }) }).catch(x => x),
    ]);
    for (const e of errs) { expect(e).toBeInstanceOf(CredentialRefError); expect(e.message).not.toContain(SECRET); }
  });
});
