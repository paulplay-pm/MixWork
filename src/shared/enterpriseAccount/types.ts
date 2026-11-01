import type { EnterpriseQuotaReason } from './constants';

export interface EnterpriseQuotaErrorDetails {
  code: number;
  reason: EnterpriseQuotaReason;
}
