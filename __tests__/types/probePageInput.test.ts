/**
 * ProbePageInputSchema validation tests — Phase 2.1 of /feature-lifecycle probe-page.
 *
 * These tests REFERENCE the contract from system requirements (bead pe5c) and
 * MUST FAIL until 4.1 ships the schema. Failure mode: schema is z.never() stub
 * so every safeParse({...}) returns { success: false }.
 */

import { ProbePageInputSchema, ProbePageTargetSchema } from '../../types/index.js';

describe('ProbePageInputSchema', () => {
  describe('targets array', () => {
    test('minimal valid input: single target with url only', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targets).toHaveLength(1);
        expect(result.data.targets[0].url).toBe('https://example.com');
      }
    });

    test('missing targets: rejects', () => {
      const result = ProbePageInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test('empty targets array: rejects (min 1 enforced)', () => {
      const result = ProbePageInputSchema.safeParse({ targets: [] });
      expect(result.success).toBe(false);
    });

    test('21 targets: rejects (max 20 enforced)', () => {
      const targets = Array.from({ length: 21 }, (_, i) => ({ url: `https://example.com/${i}` }));
      const result = ProbePageInputSchema.safeParse({ targets });
      expect(result.success).toBe(false);
    });

    test('exactly 20 targets: accepts', () => {
      const targets = Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}` }));
      const result = ProbePageInputSchema.safeParse({ targets });
      expect(result.success).toBe(true);
    });
  });

  describe('per-target wait config', () => {
    test('valid per-URL waitForLoadState enum values accepted', () => {
      for (const state of ['load', 'domcontentloaded', 'networkidle']) {
        const result = ProbePageInputSchema.safeParse({
          targets: [{ url: 'https://example.com', waitForLoadState: state }],
        });
        expect(result.success).toBe(true);
      }
    });

    test('invalid waitForLoadState rejects', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com', waitForLoadState: 'idle' }],
      });
      expect(result.success).toBe(false);
    });

    test('waitForLoadState defaults to "load" when omitted', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targets[0].waitForLoadState).toBe('load');
      }
    });

    test('per-URL timeoutMs default = 10000', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targets[0].timeoutMs).toBe(10000);
      }
    });

    test('per-URL timeoutMs below 1000 rejects', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com', timeoutMs: 500 }],
      });
      expect(result.success).toBe(false);
    });

    test('per-URL timeoutMs above 30000 rejects', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com', timeoutMs: 31000 }],
      });
      expect(result.success).toBe(false);
    });

    test('per-URL waitForSelector accepts arbitrary string', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com', waitForSelector: 'h1.main-title' }],
      });
      expect(result.success).toBe(true);
    });

    test('different config per target works', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [
          { url: 'https://example.com/a', timeoutMs: 5000 },
          { url: 'https://example.com/b', timeoutMs: 20000, waitForLoadState: 'networkidle' },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.targets[0].timeoutMs).toBe(5000);
        expect(result.data.targets[1].timeoutMs).toBe(20000);
        expect(result.data.targets[1].waitForLoadState).toBe('networkidle');
      }
    });
  });

  describe('per-target url validation', () => {
    test('missing url within target: rejects', () => {
      const result = ProbePageInputSchema.safeParse({ targets: [{}] });
      expect(result.success).toBe(false);
    });

    test('non-URL string within target: rejects', () => {
      const result = ProbePageInputSchema.safeParse({ targets: [{ url: 'not-a-url' }] });
      expect(result.success).toBe(false);
    });

    test('localhost URL accepts', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'http://localhost:3000' }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('batch-wide flags', () => {
    test('includeHtml defaults to false', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHtml).toBe(false);
      }
    });

    test('captureScreenshots defaults to true', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.captureScreenshots).toBe(true);
      }
    });

    test('explicit captureScreenshots: false accepted', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
        captureScreenshots: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.captureScreenshots).toBe(false);
      }
    });
  });

  describe('forbidden agent fields (zero-LLM contract)', () => {
    // probe_page must NEVER accept agent-flavored inputs. Locking this in the
    // schema prevents accidental drift back into LLM territory.
    test('description field on input: rejects (no agent task in probe_page)', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
        description: 'verify the page renders',
      });
      expect(result.success).toBe(false);
    });

    test('credentialId field rejects (auth is rfln scope, not probe_page)', () => {
      const result = ProbePageInputSchema.safeParse({
        targets: [{ url: 'https://example.com' }],
        credentialId: '00000000-0000-0000-0000-000000000000',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('ProbePageTargetSchema (standalone)', () => {
  test('parses a valid target object directly', () => {
    const result = ProbePageTargetSchema.safeParse({
      url: 'https://example.com',
      waitForLoadState: 'networkidle',
      timeoutMs: 15000,
    });
    expect(result.success).toBe(true);
  });
});
