import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import { resolveAuditRange, resolveUsageRange, UsageRange } from '../../src/analytics/range';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';

async function seedOrg(timezone: string): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o1','T',$1)`, [timezone]);
  return 'o1';
}

async function seedOrgAs(id: string, timezone: string): Promise<string> {
  await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ($1,$2,$3)`, [id, id, timezone]);
  return id;
}

// Intl-only helpers. These deliberately avoid date-fns-tz so the assertions below
// check the module against an independent authority rather than against itself.

/** The 'YYYY-MM-DD' that `instant` falls on in `zone`, via Intl. */
function localDayIn(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The first real instant whose local date in `zone` is `day`, found by a
 * coarse-to-fine scan. Returns null if no such instant exists in the searched
 * window (a zone that skipped the whole day).
 *
 * Scans by 15 minutes then refines to the minute, so it stays an independent
 * linear check rather than borrowing the module's binary search, while costing
 * ~200 Intl calls per day instead of ~5800.
 */
function firstInstantOnLocalDay(day: string, zone: string): Date | null {
  const [y, m, d] = day.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, 0, 0, 0) - 2 * 86400000;
  const end = base + 4 * 86400000;
  let found = -1;
  for (let t = base; t <= end; t += 900000) {
    if (localDayIn(new Date(t), zone) === day) { found = t; break; }
  }
  if (found < 0) return null;
  for (let t = found - 900000; t < found; t += 60000) {
    if (localDayIn(new Date(t), zone) === day) return new Date(t);
  }
  return new Date(found);
}

describe('analytics/range', () => {
  beforeEach(async () => { await resetSchema(); await runMigrations(); });

  test('today spans one day and is half-open at the next midnight', async () => {
    await seedOrg('UTC');
    const r = await resolveUsageRange('o1', UsageRange.Today);
    expect(r.days).toHaveLength(1);
    expect(r.to.getTime() - r.from.getTime()).toBe(24 * 3600 * 1000);
    expect(r.days[0]).toBe(r.from.toISOString().slice(0, 10));
  });

  test('7d and 30d include today and span N days', async () => {
    await seedOrg('UTC');
    expect((await resolveUsageRange('o1', UsageRange.Last7Days)).days).toHaveLength(7);
    expect((await resolveUsageRange('o1', UsageRange.Last30Days)).days).toHaveLength(30);
  });

  test('this_month runs from the 1st to the next month boundary', async () => {
    await seedOrg('UTC');
    const r = await resolveUsageRange('o1', UsageRange.ThisMonth);
    expect(r.from.getUTCDate()).toBe(1);
    expect(r.to.getUTCDate()).toBe(1);
    expect(r.days.length).toBeGreaterThan(0);
  });

  test('last_month covers a whole previous calendar month', async () => {
    await seedOrg('UTC');
    const r = await resolveUsageRange('o1', UsageRange.LastMonth);
    expect(r.from.getUTCDate()).toBe(1);
    expect(r.to.getUTCDate()).toBe(1);
    expect(r.to.getTime() - r.from.getTime()).toBeGreaterThanOrEqual(27 * 86400000);
  });

  test('day boundaries follow orgs.timezone, not the server clock', async () => {
    await seedOrg('Pacific/Kiritimati'); // UTC+14 — the most positive offset
    const r = await resolveUsageRange('o1', UsageRange.Today);
    expect(r.timezone).toBe('Pacific/Kiritimati');
    expect(r.to.getTime() - r.from.getTime()).toBe(24 * 3600 * 1000);
  });

  test('an invalid orgs.timezone falls back to UTC instead of throwing', async () => {
    await seedOrg('Not/AZone');
    const r = await resolveUsageRange('o1', UsageRange.Today);
    expect(r.timezone).toBe('UTC');
  });

  test('audit custom requires both from and to', async () => {
    await seedOrg('UTC');
    await expect(resolveAuditRange('o1', 'custom', { from: '2026-03-01' })).rejects.toThrow();
    await expect(resolveAuditRange('o1', 'custom', { to: '2026-03-01' })).rejects.toThrow();
  });

  test('audit custom is inclusive of both named days', async () => {
    await seedOrg('UTC');
    const r = await resolveAuditRange('o1', 'custom', { from: '2026-03-01', to: '2026-03-05' });
    expect(r.days).toEqual(['2026-03-01','2026-03-02','2026-03-03','2026-03-04','2026-03-05']);
    expect(r.from.toISOString().slice(0,10)).toBe('2026-03-01');
    expect(r.to.toISOString().slice(0,10)).toBe('2026-03-06'); // exclusive upper bound
  });

  // Regression (mirror case): when DST ENDS at 00:00, local midnight happens TWICE.
  // Resolving "local midnight" naively returns the SECOND occurrence, so the day
  // loses its first hour — and because the local date is identical either way, the
  // `localDay(from) === days[0]` assertion does NOT catch it. These two tests pin
  // the exact instant instead, and both fail against the old behaviour.
  test('a fall-back day starts at the FIRST of its two local midnights', async () => {
    await seedOrg('America/Havana'); // DST ends 2025-11-02, 01:00 -> 00:00
    const r = await resolveAuditRange('o1', 'custom', { from: '2025-11-02', to: '2025-11-02' });
    // 04:00Z is local 00:00 -04:00 (the first one). The old code returned 05:00Z.
    expect(r.from.toISOString()).toBe('2025-11-02T04:00:00.000Z');
    expect(r.days).toEqual(['2025-11-02']);
  });

  test('a fall-back day is the full 25 hours of real time', async () => {
    await seedOrg('America/Havana');
    const r = await resolveAuditRange('o1', 'custom', { from: '2025-11-02', to: '2025-11-02' });
    expect(r.to.getTime() - r.from.getTime()).toBe(25 * 3600 * 1000);
  });

  test('a spring-forward day starts at the transition, not the missing midnight', async () => {
    await seedOrg('America/Havana'); // DST starts 2025-03-09, 00:00 -> 01:00
    const r = await resolveAuditRange('o1', 'custom', { from: '2025-03-09', to: '2025-03-09' });
    // 05:00Z is local 01:00 -04:00. The old code returned 04:00Z, which reads as
    // the PREVIOUS local day entirely.
    expect(r.from.toISOString()).toBe('2025-03-09T05:00:00.000Z');
    expect(localDayIn(r.from, 'America/Havana')).toBe('2025-03-09');
    expect(r.to.getTime() - r.from.getTime()).toBe(23 * 3600 * 1000);
  });

  test('audit custom rejects days that only look valid', async () => {
    await seedOrg('UTC');
    for (const bad of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '0050-06-01', '9999-12-31']) {
      await expect(resolveAuditRange('o1', 'custom', { from: '2026-03-01', to: bad })).rejects.toThrow();
      await expect(resolveAuditRange('o1', 'custom', { from: bad, to: '2026-03-05' })).rejects.toThrow();
    }
  });

  // Regression: a zone whose DST jump skips local midnight (00:00 -> 01:00) has no
  // midnight to land on. Resolving the boundary as plain local midnight returned an
  // instant whose LOCAL date was the day before `days[0]` claimed, so the day list
  // and the interval disagreed — the exact page-vs-export skew this module prevents.
  test('a zone that skips local midnight still starts on the requested day', async () => {
    await seedOrg('America/Havana'); // 00:00 -> 01:00 on 2026-03-08
    const r = await resolveAuditRange('o1', 'custom', { from: '2026-03-08', to: '2026-03-08' });
    expect(r.days).toEqual(['2026-03-08']);
    // `from` must be ON the day days[0] names, in the org's zone.
    expect(localDayIn(r.from, 'America/Havana')).toBe(r.days[0]);
    expect(r.to.getTime()).toBeGreaterThan(r.from.getTime());
  });

  test('every entry in days lies inside [from, to) on its own local date', async () => {
    // The generic invariant: for each declared day there is a real start instant
    // inside the interval. Checked against an Intl-only oracle so the assertion
    // does not just re-run the implementation's own logic.
    const zones = [
      'UTC', 'Asia/Shanghai', 'America/New_York', 'America/Havana', 'America/Santiago',
      'Asia/Beirut', 'Africa/Cairo', 'Atlantic/Azores', 'Pacific/Kiritimati', 'Asia/Kathmandu',
      'Australia/Lord_Howe', 'Pacific/Apia', 'Pacific/Chatham',
    ];
    for (const zone of zones) {
      await testPool.query(`DELETE FROM orgs`);
      await seedOrgAs('o1', zone);
      for (const key of Object.values(UsageRange)) {
        const r = await resolveUsageRange('o1', key);
        expect(localDayIn(r.from, zone), `${zone}/${key} from local day`).toBe(r.days[0]);
        expect(r.days.length).toBeGreaterThan(0);
        for (const day of r.days) {
          // The day's own start must fall inside the half-open interval.
          const start = firstInstantOnLocalDay(day, zone);
          expect(start, `${zone}/${key} ${day} has no start instant`).not.toBeNull();
          expect(r.from.getTime(), `${zone}/${key} ${day} starts before from`).toBeLessThanOrEqual(start!.getTime());
          expect(start!.getTime(), `${zone}/${key} ${day} starts at or after to`).toBeLessThan(r.to.getTime());
        }
        expect(localDayIn(new Date(r.to.getTime() - 1), zone), `${zone}/${key} last day`).toBe(r.days[r.days.length - 1]);
      }
    }
  });
});
