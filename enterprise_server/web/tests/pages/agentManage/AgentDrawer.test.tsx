import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import type { AgentMarketplaceItem } from '../../../src/api/agentMarketplace';
import type { DeptNode } from '../../../src/api/departments';
import type { UserRow } from '../../../src/api/users';
import { setLang } from '../../../src/i18n';
import { AgentDrawer } from '../../../src/pages/agentManage/drawer/AgentDrawer';

const item = (): AgentMarketplaceItem => ({ agentId: 'a1', name: 'N', description: 'd', identity: 'i', systemPrompt: 'p', model: 'gpt-5', thinkingLevel: 'medium', icon: 'bot', iconColor: 2, aboutYou: '', skillIds: [], subagentAllowAgentIds: [], scope: { allCompany: false, deptIds: ['d1'], userIds: [] }, enabled: true, imChannels: ['feishu'] });

const dept = (id: string, name: string, parent: string | null = null): DeptNode => ({
  id, name, code: null, parent_id: parent, path: parent ? `/${parent}/${id}` : `/${id}`,
  leader_id: null, sort: 0, description: null, directMembers: 0, subtreeMembers: 0, children: [],
});

const member = (id: string, name: string): UserRow => ({
  id, org_id: 'o1', username: id, display_name: name, email: null, phone: null,
  position: null, level: null, department_id: null, primary_dept_name: null,
  timezone: null, extra_roles: [], status: 'active', joined_at: null,
  last_login_at: null, created_at: '',
});

// The org root plus two departments under it — the root checkbox is the
// whole-company grant, the two children are department grants.
const DEPTS = [dept('d0', '公司'), dept('d1', '研发部', 'd0'), dept('d2', '产品部', 'd0')];
const MEMBERS = [member('u1', '张三')];

describe('AgentDrawer', () => {
  test('renders all 7 tabs and the save button', () => {
    // jsdom reports navigator.language = 'en-US'; the assertions below are
    // written against the zh dictionary, so pin the locale explicitly.
    setLang('zh');
    render(<AgentDrawer mode="edit" agent={item()} depts={DEPTS} members={MEMBERS} skills={[]} agents={[item()]} models={[]} modelsError onSave={async()=>{}} onClose={()=>{}} />);
    for (const label of ['助手身份','助手性格','关于你','技能','协作','IM 渠道','可见范围']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument();
  });

  test('skills tab lists skills and toggling updates selection via save payload', async () => {
    let saved: unknown;
    const skills = [
      { id: 's1', name: 'SQL 查询', name_zh: 'SQL 查询' },
      { id: 's2', name: '文档生成', name_zh: '文档生成' },
    ];
    // The fixture seeds a department grant, so save validation passes and the
    // save-payload assertion can run; the skills toggling behavior under test
    // is unchanged.
    render(<AgentDrawer mode="create" agent={item()} depts={DEPTS} members={MEMBERS} skills={skills} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: '技能' }));
    expect(screen.getByText('SQL 查询')).toBeInTheDocument();
    // Click the SQL row to select it.
    fireEvent.click(screen.getByText('SQL 查询'));
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect((saved as { skill_ids?: string[] }).skill_ids).toEqual(['s1']));
  });

  test('scope tab shows the granted department and save is blocked when the scope is emptied', async () => {
    let saved: unknown;
    // Seed one granted department (d1) so there is a chip to remove —
    // emptyDraft() starts with no grant (min-1 ruling), so a bare create draft
    // has none; this mirrors the fixture.
    render(<AgentDrawer mode="create" agent={item()} depts={DEPTS} members={MEMBERS} skills={[]} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('tab', { name: '可见范围' }));
    // The granted department shows as a chip.
    expect(screen.getByRole('button', { name: '研发部' })).toBeInTheDocument();
    // Remove it via its chip → the scope is now empty.
    fireEvent.click(screen.getByRole('button', { name: '研发部' }));
    // Now click save → should be blocked (scope empty), no POST.
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect(saved).toBeUndefined());
    expect(screen.getByText('至少选择一个部门或成员')).toBeInTheDocument();
  });

  test('scope tab grants a department from the tree and saves it', async () => {
    let saved: unknown;
    setLang('zh');
    render(<AgentDrawer mode="create" agent={item()} depts={DEPTS} members={MEMBERS} skills={[]} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('tab', { name: '可见范围' }));
    // Open the picker and tick a department that is not granted yet.
    // Checkbox 0 is the 全公司 row, 1 is the org root (公司) and 2/3 are
    // 研发部/产品部.
    fireEvent.click(screen.getByRole('button', { name: '可见范围' }));
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[3]);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect((saved as { scope?: { deptIds: string[] } }).scope?.deptIds).toEqual(['d1', 'd2']));
  });

  test('icon tile popover changes the draft color on pick', async () => {
    let saved: unknown;
    // The fixture seeds a department grant, so save is not blocked and
    // onSave can fire; the icon_color pick is the real behavior under test.
    render(<AgentDrawer mode="create" agent={item()} depts={DEPTS} members={MEMBERS} skills={[]} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'X' } });
    // Open the icon popover via the tile's aria-label 更换图标.
    fireEvent.click(screen.getByRole('button', { name: /更换图标/ }));
    // Pick the 6th color swatch (index 5). The item() fixture seeds
    // iconColor: 2, so asserting icon_color === 5 proves the swatch pick
    // actually changed the draft color (a no-op pick would still read 2).
    const swatches = screen.getAllByRole('button', { name: /颜色/ });
    fireEvent.click(swatches[5]);
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect((saved as { icon_color?: number }).icon_color).toBe(5));
  });

  test('subagent tab disables a cyclic candidate with a 成环 note', async () => {
    // editing a1; a2 references a1 → selecting a2 would form a cycle.
    const a1: AgentMarketplaceItem = { agentId: 'a1', name: 'A1', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: 'bot', iconColor: 0, aboutYou: '', skillIds: [], subagentAllowAgentIds: [], scope: { allCompany: false, deptIds: ['d1'], userIds: [] }, enabled: true, imChannels: [] };
    const a2: AgentMarketplaceItem = { ...a1, agentId: 'a2', name: 'A2', subagentAllowAgentIds: ['a1'] };
    render(<AgentDrawer mode="edit" agent={a1} depts={DEPTS} members={MEMBERS} skills={[]} agents={[a1, a2]} models={[]} onSave={async()=>{}} onClose={()=>{}} />);
    fireEvent.click(screen.getByRole('tab', { name: '协作' }));
    const a2row = screen.getByText('A2').closest('button') as HTMLButtonElement;
    expect(a2row).toBeDisabled();
    expect(screen.getByText('成环')).toBeInTheDocument();
  });

  test('IM tab lists all 5 channels with switches; toggling one puts it in im_channels', async () => {
    setLang('zh');
    let saved: unknown;
    // item() seeds imChannels: ['feishu'], so 飞书 starts on and the rest off.
    render(<AgentDrawer mode="create" agent={item()} depts={DEPTS} members={MEMBERS} skills={[]} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'IM 渠道' }));
    const names = ['微信', '钉钉', '飞书', '企业微信', 'QQ'];
    for (const n of names) {
      expect(screen.getByText(n)).toBeInTheDocument();
    }
    // 飞书 is pre-selected (on); 微信 starts off.
    expect(screen.getByRole('switch', { name: '飞书' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: '微信' })).toHaveAttribute('aria-checked', 'false');
    // Turn on 钉钉, then save.
    fireEvent.click(screen.getByRole('switch', { name: '钉钉' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'IM Bot' } });
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect((saved as { im_channels?: string[] }).im_channels).toEqual(['feishu', 'dingtalk']));
  });

  test('edit mode shows a non-blocking warning when another agent shares the draft name', () => {
    setLang('zh');
    // a1 and a2 share the name 'N' (the item() fixture) but differ by agentId.
    const a1 = item();
    const a2: AgentMarketplaceItem = { ...a1, agentId: 'a2' };
    render(<AgentDrawer mode="edit" agent={a1} depts={DEPTS} members={MEMBERS} skills={[]} agents={[a1, a2]} models={[]} onSave={async()=>{}} onClose={()=>{}} />);
    // The warning is a note under the name field — it does not block save.
    expect(screen.getByText(/已有同名智能体/)).toBeInTheDocument();
  });
});
