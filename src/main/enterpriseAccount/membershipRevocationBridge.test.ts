import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  _resetMembershipRevocationHandlerForTest,
  handleEnterpriseMembershipRevocation,
  setMembershipRevocationHandler,
} from './membershipRevocationBridge';

describe('the membership revocation bridge', () => {
  beforeEach(() => {
    _resetMembershipRevocationHandlerForTest();
  });

  test('forwards to the installed handler only for 41602', () => {
    const handler = vi.fn();
    setMembershipRevocationHandler(handler);

    expect(handleEnterpriseMembershipRevocation(41602, 'JsonApi')).toBe(true);
    expect(handler).toHaveBeenCalledWith('JsonApi');

    // Everything else is somebody else's error: 401 quota, 403 scope, a
    // string code the caller forgot to parse.
    expect(handleEnterpriseMembershipRevocation(41601, 'JsonApi')).toBe(false);
    expect(handleEnterpriseMembershipRevocation(undefined, 'JsonApi')).toBe(false);
    expect(handleEnterpriseMembershipRevocation('41602', 'JsonApi')).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('no handler installed is not a crash', () => {
    expect(handleEnterpriseMembershipRevocation(41602, 'JsonApi')).toBe(false);
  });

  test('installing null uninstalls', () => {
    const handler = vi.fn();
    setMembershipRevocationHandler(handler);
    setMembershipRevocationHandler(null);
    expect(handleEnterpriseMembershipRevocation(41602, 'JsonApi')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
