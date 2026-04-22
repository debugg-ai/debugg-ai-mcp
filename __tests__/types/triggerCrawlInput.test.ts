/**
 * TriggerCrawlInputSchema validation tests.
 *
 * Proof point for bead i0v (Define TriggerCrawlInput Zod schema + types).
 * Exercises the schema's contract: what's required, what's optional, what
 * normalization happens, what's rejected.
 */

import { TriggerCrawlInputSchema } from '../../types/index.js';

describe('TriggerCrawlInputSchema', () => {
  describe('required fields', () => {
    test('minimal valid input: only url', () => {
      const result = TriggerCrawlInputSchema.safeParse({ url: 'https://example.com' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe('https://example.com');
      }
    });

    test('missing url: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test('invalid url string: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({ url: 'not a url' });
      expect(result.success).toBe(false);
    });
  });

  describe('url normalization (via shared normalizeUrl)', () => {
    test('bare "localhost:3000" gets http:// prepended', () => {
      const result = TriggerCrawlInputSchema.safeParse({ url: 'localhost:3000' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe('http://localhost:3000');
      }
    });

    test('explicit http://localhost:3000 passes through unchanged', () => {
      const result = TriggerCrawlInputSchema.safeParse({ url: 'http://localhost:3000' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe('http://localhost:3000');
      }
    });

    test('bare public domain "example.com" is NOT auto-prefixed (rejected)', () => {
      const result = TriggerCrawlInputSchema.safeParse({ url: 'example.com' });
      expect(result.success).toBe(false);
    });
  });

  describe('optional fields', () => {
    test('full-featured input: all optional fields accepted', () => {
      const input = {
        url: 'https://example.com',
        projectUuid: '269532cb-0000-0000-0000-000000000000',
        environmentId: '00000000-0000-0000-0000-000000000001',
        credentialId: '00000000-0000-0000-0000-000000000002',
        credentialRole: 'admin',
        username: 'alice',
        password: 'hunter2',
        headless: true,
        timeoutSeconds: 600,
        repoName: 'debugg-ai/my-repo',
      };
      const result = TriggerCrawlInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({
          url: 'https://example.com',
          projectUuid: input.projectUuid,
          credentialRole: 'admin',
          headless: true,
          timeoutSeconds: 600,
        });
      }
    });

    test('invalid uuid on projectUuid: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        projectUuid: 'not-a-uuid',
      });
      expect(result.success).toBe(false);
    });

    test('invalid uuid on environmentId: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        environmentId: 'nope',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('timeoutSeconds bounds', () => {
    test('positive integer within range: accepted', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        timeoutSeconds: 600,
      });
      expect(result.success).toBe(true);
    });

    test('zero: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        timeoutSeconds: 0,
      });
      expect(result.success).toBe(false);
    });

    test('negative: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        timeoutSeconds: -1,
      });
      expect(result.success).toBe(false);
    });

    test('exceeds 1800 (30 min ceiling): rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        timeoutSeconds: 1801,
      });
      expect(result.success).toBe(false);
    });

    test('exactly 1800: accepted', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        timeoutSeconds: 1800,
      });
      expect(result.success).toBe(true);
    });

    test('non-integer: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        timeoutSeconds: 1.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('strict mode', () => {
    test('unknown key: rejects', () => {
      const result = TriggerCrawlInputSchema.safeParse({
        url: 'https://example.com',
        bogusField: 'should not pass',
      });
      expect(result.success).toBe(false);
    });
  });
});
