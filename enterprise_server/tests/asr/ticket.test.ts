import '../helpers/setupEnv';

import { beforeEach, describe, expect, test } from 'vitest';

import { _resetAsrTicketsForTest, issueAsrTicket, redeemAsrTicket } from '../../src/asr/ticket';

const base = {
  orgId: 'o1',
  userId: 'u1',
  requestId: 'r1',
  langType: 'zh-CHS',
  providerKeyId: 'pk1',
  protocol: 'realtime-asr',
};

describe('asr ticket', () => {
  beforeEach(() => {
    _resetAsrTicketsForTest();
  });

  // The relay cannot see the session route's config object: it re-reads the
  // provider row itself. The ticket is the only channel the catalog's chosen
  // model can travel on, so dropping it on redemption would silently send the
  // stale `provider_keys.config.model` upstream.
  test('模型随票据往返', async () => {
    const redeemed = await redeemAsrTicket(await issueAsrTicket({ ...base, model: 'kimi-asr' }));
    expect(redeemed?.model).toBe('kimi-asr');
  });

  test('没有模型时票据里也没有这个字段', async () => {
    const redeemed = await redeemAsrTicket(await issueAsrTicket(base));
    expect(redeemed?.model).toBeUndefined();
  });

  test('票据仍然是一次性的', async () => {
    const ticket = await issueAsrTicket({ ...base, model: 'kimi-asr' });
    expect(await redeemAsrTicket(ticket)).not.toBeNull();
    expect(await redeemAsrTicket(ticket)).toBeNull();
  });
});
