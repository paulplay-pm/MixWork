import { describe, expect, test, vi } from 'vitest';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string): string => key },
}));

import { loginErrorMessage } from './loginErrorMessage';

describe('loginErrorMessage', () => {
  test('each server failure code maps to its own message', () => {
    expect(loginErrorMessage('org_not_found')).toBe('enterpriseLoginErrorOrgNotFound');
    // An unknown username and a wrong password must read identically, so
    // the login form cannot be used to enumerate accounts.
    expect(loginErrorMessage('user_not_found')).toBe('enterpriseLoginErrorInvalid');
    expect(loginErrorMessage('invalid_password')).toBe('enterpriseLoginErrorInvalid');
    expect(loginErrorMessage('user_disabled')).toBe('enterpriseLoginErrorUserDisabled');
    expect(loginErrorMessage('rate_limited')).toBe('enterpriseLoginErrorRateLimited');
    expect(loginErrorMessage('org_required')).toBe('enterpriseLoginErrorOrgRequired');
    expect(loginErrorMessage('invalid')).toBe('enterpriseLoginErrorInvalid');
    expect(loginErrorMessage('network')).toBe('enterpriseLoginErrorNetwork');
    expect(loginErrorMessage('server')).toBe('enterpriseLoginErrorServer');
  });

  test('an unknown code falls back to the raw error text', () => {
    expect(loginErrorMessage('something_new', 'http 418')).toBe('http 418');
  });

  test('no code and no error text falls back to the generic message', () => {
    expect(loginErrorMessage(null, '   ')).toBe('enterpriseLoginFailed');
    expect(loginErrorMessage(undefined)).toBe('enterpriseLoginFailed');
  });
});
