import { expect, test } from 'bun:test';
import { getRemoteCommandDefinition, validateRemoteCommandArgs } from '../src/remote-command-registry';

test('mobile can read quotas, switch accounts and explicitly consume a reset with an idempotency key', () => {
  for (const channel of ['openai-accounts:list', 'openai-accounts:get-active']) {
    expect(getRemoteCommandDefinition(channel)?.risk).toBe('read');
    expect(validateRemoteCommandArgs(channel, []).ok).toBe(true);
  }
  expect(validateRemoteCommandArgs('openai-accounts:query-quota', [{ accountId: 'a' }]).ok).toBe(true);
  expect(getRemoteCommandDefinition('openai-accounts:set-active')?.risk).toBe('write_safe');
  expect(getRemoteCommandDefinition('openai-accounts:reset-quota')?.risk).toBe('execute');
  expect(validateRemoteCommandArgs('openai-accounts:reset-quota', [{ accountId: 'a' }]).ok).toBe(false);
  expect(validateRemoteCommandArgs('openai-accounts:reset-quota', [{ accountId: 'a', idempotencyKey: 'key' }]).ok).toBe(true);
  for (const suffix of ['get-auth-json', 'set-auth-json', 'get-details', 'import', 'start-login', 'delete']) {
    expect(getRemoteCommandDefinition(`openai-accounts:${suffix}`)).toBeUndefined();
  }
});
