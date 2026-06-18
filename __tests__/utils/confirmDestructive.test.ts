/**
 * ensureConfirmed — destructive-action guard (decision D2).
 *
 * Two protection paths: elicitation when the client supports it, else a
 * required confirm:true arg. Non-destructive actions always pass through.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { ensureConfirmed, isDestructiveAction, DESTRUCTIVE_ACTIONS } from '../../utils/confirmDestructive.js';
import { ToolContext } from '../../types/index.js';

const ctx = (elicit?: ToolContext['elicit']): ToolContext => ({
  timestamp: new Date(),
  elicit,
});

describe('ensureConfirmed', () => {
  test('proceeds (returns null) for non-destructive actions', async () => {
    expect(await ensureConfirmed('create', 'project X', {}, ctx())).toBeNull();
    expect(await ensureConfirmed('get', 'env Y', {}, ctx())).toBeNull();
  });

  test('delete without elicit and without confirm → confirmation_required', async () => {
    const res = await ensureConfirmed('delete', 'environment Z', {}, ctx());
    expect(res).not.toBeNull();
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).toContain('confirmation_required');
  });

  test('delete with confirm:true and no elicit → proceeds', async () => {
    expect(await ensureConfirmed('delete', 'environment Z', { confirm: true }, ctx())).toBeNull();
  });

  test('delete with elicit accept+confirm → proceeds', async () => {
    const elicit = jest.fn(async () => ({ action: 'accept', content: { confirm: true } }));
    expect(await ensureConfirmed('delete', 'suite S', {}, ctx(elicit))).toBeNull();
    expect(elicit).toHaveBeenCalledTimes(1);
  });

  test('delete with elicit decline → confirmation_declined', async () => {
    const elicit = jest.fn(async () => ({ action: 'decline' }));
    const res = await ensureConfirmed('delete', 'suite S', {}, ctx(elicit));
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).toContain('confirmation_declined');
  });

  test('delete with elicit accept but confirm:false → declined', async () => {
    const elicit = jest.fn(async () => ({ action: 'accept', content: { confirm: false } }));
    const res = await ensureConfirmed('delete', 'case C', {}, ctx(elicit));
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).toContain('confirmation_declined');
  });

  test('DESTRUCTIVE_ACTIONS exposes delete', () => {
    expect(isDestructiveAction('delete')).toBe(true);
    expect(isDestructiveAction('update')).toBe(false);
    expect(DESTRUCTIVE_ACTIONS.has('delete')).toBe(true);
  });
});
