import { describe, expect, test } from 'vitest';

import { AsrApiCode } from '../../../shared/asr/constants';
import { EnterpriseApiErrorCode } from '../../../shared/enterpriseAccount/constants';
import { getFallbackAsrErrorMessage } from './errors';

describe('voice input error codes', () => {
  test('撤销成员的数字码 41602 显示"需要登录"，而不是通用服务失败', () => {
    // Otherwise a revoked member is told the SERVICE failed, when what
    // actually happened is their membership ended.
    const msg = getFallbackAsrErrorMessage(EnterpriseApiErrorCode.NotMember);
    expect(msg).not.toBe(getFallbackAsrErrorMessage(AsrApiCode.UpstreamError));
    expect(msg.length).toBeGreaterThan(0);
  });

  test('服务端会发出的每个码都有映射，不落 default', () => {
    const codes = [
      AsrApiCode.Unauthorized,
      AsrApiCode.ConfigInvalid,
      AsrApiCode.AudioInvalid,
      AsrApiCode.AudioTooLarge,
      AsrApiCode.AudioTooLong,
      AsrApiCode.DailyLimitExceeded,
      AsrApiCode.UpstreamAuthFailed,
      AsrApiCode.UpstreamRateLimited,
      AsrApiCode.RecognitionFailed,
      AsrApiCode.UpstreamError,
      AsrApiCode.UpstreamBalanceInsufficient,
      AsrApiCode.UpstreamInvalidParams,
      EnterpriseApiErrorCode.NotMember,
    ];
    const generic = getFallbackAsrErrorMessage(undefined);
    for (const code of codes) {
      expect(getFallbackAsrErrorMessage(code)).not.toBe(generic);
    }
  });
});
