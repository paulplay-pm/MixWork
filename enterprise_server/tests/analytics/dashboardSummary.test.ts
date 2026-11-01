import '../helpers/setupEnv';

import { beforeEach, describe, expect, test, vi } from 'vitest';
vi.mock('../../src/db/pool', async () => {
  const td = await import('../../src/db/testDb');
  return { pool: td.testPool };
});
import {
  queryActivities,
  queryAgentCounts,
  queryHealth,
  queryMcpCounts,
  queryUserCounts,
} from '../../src/analytics/dashboard';
import { resetSchema, runMigrations, testPool } from '../../src/db/testDb';
import { agent, audit, mcp, providerKey, seedOrg, user } from '../helpers/dashboardSeed';

/** The activity feed resolves a 7-day window from the real clock, so fixtures
 *  dated April 2026 fall outside it unless the clock is pinned here too. */
const APRIL_NOW = new Date('2026-04-15T09:30:00Z');

async function inApril<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  vi.setSystemTime(APRIL_NOW);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

describe('analytics/dashboard — 配置类聚合', () => {
  beforeEach(async () => {
    await resetSchema();
    await runMigrations();
  });

  test('queryUserCounts 按 status 拆分总数', async () => {
    await seedOrg();
    await user('u1');
    await user('u2');
    await user('u3');
    await user('u4', { status: 'disabled' });
    await user('u5', { status: 'disabled' });
    expect(await queryUserCounts('o1')).toEqual({ total: 5, enabled: 3, disabled: 2 });
  });

  test('queryAgentCounts 统计本组织的 enabled（migration 053 之后按 org 收窄）', async () => {
    await seedOrg();
    await agent('a1', true);
    await agent('a2', true);
    await agent('a3', false);
    expect(await queryAgentCounts('o1')).toEqual({ enabled: 2, total: 3 });
  });

  test('queryAgentCounts 不计入其他组织的智能体', async () => {
    await seedOrg();
    await agent('o1-agent', true, 'o1');
    await agent('o2-agent', true, 'o2');
    expect(await queryAgentCounts('o1')).toEqual({ enabled: 1, total: 1 });
    expect(await queryAgentCounts('o2')).toEqual({ enabled: 1, total: 1 });
  });

  test('queryMcpCounts 的 abnormal 只数启用中的 failed 行，且不受列表截断影响', async () => {
    await seedOrg();
    await mcp('c1', { status: 'failed', testedAt: '2026-04-15T08:00:00Z', en: 'CRM' });
    await mcp('c2', { status: 'failed', testedAt: '2026-04-15T09:00:00Z', en: 'Newer CRM' });
    await mcp('c3', { status: 'failed', enabled: false, en: 'Disabled' });
    await mcp('c4', { status: 'connected' });
    await mcp('c5');
    const r = await queryMcpCounts('o1');
    expect(r.enabled).toBe(4);
    expect(r.total).toBe(5);
    expect(r.abnormal).toBe(2);
    // firstAbnormal = 最近一次检测失败的那条，与健康列表的取前 6 无关
    expect(r.firstAbnormal).toBe('Newer CRM');
  });

  test('queryHealth 把 err 排第一、unknown 排最后，组内按 last_test_at 倒序', async () => {
    await seedOrg();
    await providerKey('p1', { status: 'connected', latency: 400, testedAt: '2026-04-15T09:00:00Z', label: 'OpenAI' });
    await providerKey('p2', { status: 'failed', testedAt: '2026-04-15T08:00:00Z', label: 'Anthropic' });
    await providerKey('p3', { status: 'connected', latency: 5000, testedAt: '2026-04-15T07:00:00Z', label: 'Slow' });
    await providerKey('p4');
    const { items } = await queryHealth({ orgId: 'o1', includeModel: true, includeMcp: true });
    expect(items.map((i) => i.status)).toEqual(['err', 'warn', 'ok', 'unknown']);
    expect(items[0].nameEn).toBe('Anthropic');
  });

  test('queryHealth 用 latencyMs>3000 判 warn、<=3000 判 ok、last_test_at 为 null 判 unknown', async () => {
    await seedOrg();
    await providerKey('fast', { status: 'connected', latency: 3000, testedAt: '2026-04-15T09:00:00Z' });
    await providerKey('slow', { status: 'connected', latency: 3001, testedAt: '2026-04-15T09:00:00Z' });
    await providerKey('never');
    const { items } = await queryHealth({ orgId: 'o1', includeModel: true, includeMcp: true });
    const by = Object.fromEntries(items.map((i) => [i.nameEn, i.status]));
    expect(by.fast).toBe('ok');
    expect(by.slow).toBe('warn');
    expect(by.never).toBe('unknown');
  });

  test('queryHealth 的 includeModel=false 时不返回模型条目，checkedAt 只按可见行取', async () => {
    await seedOrg();
    await providerKey('p1', { status: 'connected', latency: 10, testedAt: '2026-04-15T09:00:00Z', label: 'Model Side' });
    await mcp('c1', { status: 'connected', latency: 10, testedAt: '2026-04-15T01:00:00Z', en: 'Mcp Side' });
    const r = await queryHealth({ orgId: 'o1', includeModel: false, includeMcp: true });
    expect(r.items.every((i) => i.kind === 'mcp')).toBe(true);
    // 模型侧那次更晚的检测不能通过时间戳泄漏给没有 provider:view 的调用方
    expect(r.checkedAt).toBe('2026-04-15T01:00:00.000Z');
  });

  test('queryHealth 的 limit 截断列表', async () => {
    await seedOrg();
    for (let i = 0; i < 9; i++) {
      await providerKey(`p${i}`, { status: 'connected', latency: 10, testedAt: '2026-04-15T09:00:00Z' });
    }
    const r = await queryHealth({ orgId: 'o1', includeModel: true, includeMcp: true, limit: 6 });
    expect(r.items).toHaveLength(6);
  });

  test('queryHealth 同时返回模型与 MCP，且类型标签正确', async () => {
    await seedOrg();
    await providerKey('p1', { status: 'connected', latency: 10, testedAt: '2026-04-15T09:00:00Z', label: 'OpenAI' });
    await mcp('c1', { status: 'connected', latency: 10, testedAt: '2026-04-15T09:00:00Z', zh: '企业知识库', en: 'KB' });
    const { items } = await queryHealth({ orgId: 'o1', includeModel: true, includeMcp: true });
    expect(items.map((i) => i.kind).sort()).toEqual(['mcp', 'model']);
    const mcpItem = items.find((i) => i.kind === 'mcp')!;
    expect(mcpItem.nameZh).toBe('企业知识库');
    expect(mcpItem.nameEn).toBe('KB');
  });

  test('queryActivities 取最近 6 条、排除 provider_call、包含 login_events 的失败登录', async () => {
    await seedOrg();
    await user('u1');
    // 8 条审计：其中 3 条是被排除的 provider_call，最老的排在最前
    for (let i = 0; i < 5; i++) {
      await audit(`action_${i}`, { ts: `2026-04-15T0${i}:00:00Z` });
    }
    for (let i = 0; i < 3; i++) {
      await audit('provider_call', { ts: `2026-04-14T0${i}:00:00Z` });
    }
    await testPool.query(
      `INSERT INTO login_events(id, org_id, user_id, result, ts) VALUES ('l1','o1',NULL,'failed','2026-04-15T08:30:00Z')`
    );
    const items = await inApril(() => queryActivities('o1'));
    expect(items).toHaveLength(6);
    expect(items.some((i) => i.action === 'provider_call')).toBe(false);
    // 登录失败只存在于 login_events，不 union 进来就正好漏掉管理员最想看的那类事件
    expect(items.some((i) => i.action === 'login')).toBe(true);
  });

  test('queryActivities 按 target_type 解析目标名，未知 type 回落到 payload.name，都没有则为 null', async () => {
    await seedOrg();
    await mcp('c1', { en: '纷享销客 CRM' });
    await audit('mcp_connect_test', {
      targetType: 'connector',
      targetId: 'c1',
      ts: '2026-04-15T09:00:00Z',
    });
    await audit('weird_action', {
      targetType: 'weird_thing',
      targetId: '11111111-2222-3333-4444-555555555555',
      payload: { name: '来自 payload 的名字' },
      ts: '2026-04-15T08:00:00Z',
    });
    await audit('bare_action', {
      targetType: 'unknown_type',
      targetId: '99999999-8888-7777-6666-555555555555',
      ts: '2026-04-15T07:00:00Z',
    });
    const items = await inApril(() => queryActivities('o1'));
    const byAction = Object.fromEntries(items.map((i) => [i.action, i]));
    expect(byAction.mcp_connect_test.targetNameZh).toBe('纷享销客 CRM');
    expect(byAction.weird_action.targetNameZh).toBe('来自 payload 的名字');
    // 拿不到名字时必须为 null，绝不能把 UUID 当成名字显示给管理员
    expect(byAction.bare_action.targetNameZh).toBeNull();
  });

  test('queryActivities 解析 agent 目标名，且不解析其他组织的智能体', async () => {
    await seedOrg();
    await agent('a1', true);
    await agent('a2-other-org', true, 'o2');
    await audit('agent_created', {
      targetType: 'agent',
      targetId: 'a1',
      ts: '2026-04-15T09:00:00Z',
    });
    await audit('agent_updated', {
      targetType: 'agent',
      targetId: 'a2-other-org',
      ts: '2026-04-15T08:00:00Z',
    });
    const items = await inApril(() => queryActivities('o1'));
    const byAction = Object.fromEntries(items.map((i) => [i.action, i]));
    expect(byAction.agent_created.targetNameZh).toBe('a1');
    // 别的组织的智能体不能被解析出来
    expect(byAction.agent_updated.targetNameZh).toBeNull();
  });

  test('queryActivities 不下发 payload 原文，密钥字段不出现在结果里', async () => {
    await seedOrg();
    await audit('key_rotated', {
      targetType: 'provider_key',
      payload: { apiKey: 'sk-secret-value', secret_token: 'tok-secret-value', ok: true },
      ts: '2026-04-15T09:00:00Z',
    });
    const items = await inApril(() => queryActivities('o1'));
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized).not.toContain('tok-secret-value');
    expect(items[0]).not.toHaveProperty('payload');
  });

  test('queryActivities 解析 skill 目标名（名称列是 name_zh/name_en，不是 name）', async () => {
    await seedOrg();
    // 这两张目录表从 023/040 起就只有 name_zh/name_en。按 `name` 去查会在
    // Postgres 里直接报 `column "name" does not exist`，而这个查询在 summary 的
    // Promise.all 里 —— 一次技能更新就能让整个面板 500。
    await testPool.query(
      `INSERT INTO skill_marketplace_skills(skill_id, org_id, name_en, name_zh, description_en, category_id)
       VALUES ('s1','o1','Weather','天气','d','c')`
    );
    await audit('skill_updated', { targetType: 'skill', targetId: 's1', ts: '2026-04-15T09:00:00Z' });
    const items = await inApril(() => queryActivities('o1'));
    expect(items[0].targetNameZh).toBe('天气');
    expect(items[0].targetNameEn).toBe('Weather');
  });

  test('queryActivities 解析 kit 目标名（主键是 slug，名称列是 name_zh/name_en）', async () => {
    await seedOrg();
    await testPool.query(
      `INSERT INTO kit_catalog(slug, org_id, name_en, name_zh) VALUES ('k1','o1','Sales','销售')`
    );
    await audit('kit_updated', { targetType: 'kit', targetId: 'k1', ts: '2026-04-15T09:00:00Z' });
    const items = await inApril(() => queryActivities('o1'));
    expect(items[0].targetNameZh).toBe('销售');
    expect(items[0].targetNameEn).toBe('Sales');
  });

  test('name_zh 为空时 skill/kit 回落到 name_en，且不解析其他组织的 kit', async () => {
    await seedOrg();
    await testPool.query(`INSERT INTO orgs(id, name, timezone) VALUES ('o2','T2','UTC')`);
    await testPool.query(
      `INSERT INTO skill_marketplace_skills(skill_id, org_id, name_en, name_zh, description_en, category_id)
       VALUES ('s2','o1','Only English',NULL,'d','c')`
    );
    await testPool.query(
      `INSERT INTO kit_catalog(slug, org_id, name_en) VALUES ('k2','o2','Other Org Kit')`
    );
    await audit('skill_updated', { targetType: 'skill', targetId: 's2', ts: '2026-04-15T09:00:00Z' });
    await audit('kit_updated', { targetType: 'kit', targetId: 'k2', ts: '2026-04-15T08:00:00Z' });
    const items = await inApril(() => queryActivities('o1'));
    const byAction = Object.fromEntries(items.map((i) => [i.action, i]));
    expect(byAction.skill_updated.targetNameZh).toBe('Only English');
    // 别的组织的 kit 不能被解析出来
    expect(byAction.kit_updated.targetNameZh).toBeNull();
  });

  test('queryActivities 的 system 动作为 userId:null，userName 为 null', async () => {
    await seedOrg();
    await audit('admin_access_denied', { userId: null, ts: '2026-04-15T09:00:00Z' });
    const items = await inApril(() => queryActivities('o1'));
    expect(items[0].userId).toBeNull();
    expect(items[0].userName).toBeNull();
  });
});