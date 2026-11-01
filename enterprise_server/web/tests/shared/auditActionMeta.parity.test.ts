import { expect, test } from 'vitest';

import { AUDIT_ACTION_META as SERVER } from '../../../src/shared/auditActionMeta';
import { AuditAction as SERVER_ACTIONS } from '../../../src/shared/enterpriseServerConstants';
import {
  AUDIT_ACTION_META as WEB,
  AuditAction as WEB_ACTIONS,
  auditActionMeta as webAuditActionMeta,
  AuditTone as WEB_TONE,
} from '../../src/shared/auditActionMeta';

/**
 * `web/src/shared/auditActionMeta.ts` is a hand-kept mirror of the server
 * table (the SPA does not ship the server's src/ at runtime). Importing the
 * server module directly here means any action added, removed or relabelled
 * server-side fails this test until the mirror is brought back in step — in
 * BOTH directions, which is the direction a hand-written literal comparison
 * cannot catch: a literal copied at authoring time keeps passing forever.
 */

test('SPA action codes match the server enum', () => {
  expect(Object.values(WEB_ACTIONS).sort()).toEqual(Object.values(SERVER_ACTIONS).sort());
});

test('SPA label table matches the server table exactly, key for key and value for value', () => {
  expect(Object.keys(WEB).sort()).toEqual(Object.keys(SERVER).sort());
  for (const k of Object.keys(SERVER)) expect(WEB[k as keyof typeof WEB], k).toEqual(SERVER[k as keyof typeof SERVER]);
});

test('the mirror lookup agrees with the server lookup, fallback included', () => {
  for (const code of [...Object.values(SERVER_ACTIONS), 'something_a_client_made_up']) {
    expect(webAuditActionMeta(code), code).toEqual({
      zh: SERVER[code as keyof typeof SERVER]?.zh ?? code,
      en: SERVER[code as keyof typeof SERVER]?.en ?? code,
      tone: SERVER[code as keyof typeof SERVER]?.tone ?? WEB_TONE.Normal,
    });
  }
});