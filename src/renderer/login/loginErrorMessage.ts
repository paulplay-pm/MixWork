import { LoginErrorCode } from '../../shared/enterpriseAccount/loginErrorCodes';
import { i18nService } from '../services/i18n';

const t = (key: string): string => i18nService.t(key);

/**
 * Map a failed login to a message the user can act on.
 *
 * `code` is the server's `error` field (see `LoginErrorCode`) — it names
 * WHICH part of the credential was wrong. `fallback` is the raw error text
 * from the main process, used only when the failure carries no code we
 * recognize (e.g. a proxy error), so the user still sees something better
 * than a blank box.
 */
export const loginErrorMessage = (
  code: string | null | undefined,
  fallback?: string | null,
): string => {
  switch (code) {
    case LoginErrorCode.OrgNotFound:
      return t('enterpriseLoginErrorOrgNotFound');
    // An unknown username and a wrong password get the SAME message — the
    // server still tells us which one it was, but the user is not told, so
    // the form cannot be used to enumerate accounts.
    case LoginErrorCode.UserNotFound:
    case LoginErrorCode.InvalidPassword:
    case LoginErrorCode.Invalid:
      return t('enterpriseLoginErrorInvalid');
    case LoginErrorCode.UserDisabled:
      return t('enterpriseLoginErrorUserDisabled');
    case LoginErrorCode.RateLimited:
      return t('enterpriseLoginErrorRateLimited');
    case LoginErrorCode.OrgRequired:
      return t('enterpriseLoginErrorOrgRequired');
    case LoginErrorCode.Network:
      return t('enterpriseLoginErrorNetwork');
    case LoginErrorCode.Server:
      return t('enterpriseLoginErrorServer');
    default:
      break;
  }
  const trimmed = fallback?.trim();
  return trimmed ? trimmed : t('enterpriseLoginFailed');
};
