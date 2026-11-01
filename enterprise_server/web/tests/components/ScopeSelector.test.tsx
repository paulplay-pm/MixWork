import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import type { DeptNode } from '../../src/api/departments';
import type { UserRow } from '../../src/api/users';
import { ScopeSelector, type ScopeSelectorLabels } from '../../src/components/ScopeSelector';
import { setLang } from '../../src/i18n';

const dept = (id: string, name: string, parent: string | null = null): DeptNode => ({
  id,
  name,
  code: null,
  parent_id: parent,
  path: parent ? `/${parent}/${id}` : `/${id}`,
  leader_id: null,
  sort: 0,
  description: null,
  directMembers: 0,
  subtreeMembers: 0,
  children: [],
});

const member = (id: string, name: string): UserRow => ({
  id,
  org_id: 'o1',
  username: id,
  display_name: name,
  email: null,
  phone: null,
  position: null,
  level: null,
  department_id: null,
  primary_dept_name: null,
  timezone: null,
  extra_roles: [],
  status: 'active',
  joined_at: null,
  last_login_at: null,
  created_at: '',
});

// Two top-level departments (the org has no company-root node), one child
// under each.
const DEPTS = [
  dept('d1', '产品部'),
  dept('d2', '研发部'),
  dept('d3', '产品1组', 'd1'),
  dept('d4', '研发1组', 'd2'),
];
const MEMBERS = [member('u1', '张三'), member('u2', '李四')];

const LABELS: ScopeSelectorLabels = {
  allCompany: '全公司',
  depts: '{n} 个部门',
  users: '{m} 人',
  triggerEmpty: '点击从部门树选择，可多选',
  empty: '未选择',
  modalTitle: '授权范围',
  searchDept: '搜索部门…',
  searchMember: '搜索成员…',
  deptLabel: '部门（首行「全公司」= 全体成员）',
  members: '成员',
  memberTruncated: '（共 {n} 人，仅显示前 20 人）',
  noResult: '无匹配',
  allAdded: '已全部添加',
  done: '完成',
};

const EMPTY = { allCompany: false, deptIds: [] as string[], userIds: [] as string[] };

function renderPicker(value = EMPTY, onChange = vi.fn()): { onChange: typeof onChange } {
  setLang('zh');
  render(
    <ScopeSelector
      value={value}
      onChange={onChange}
      depts={DEPTS}
      members={MEMBERS}
      labels={LABELS}
    />,
  );
  return { onChange };
}

/** Open the modal and return the checkboxes in DOM order. */
function openPicker(): HTMLElement[] {
  fireEvent.click(screen.getByRole('button', { name: '授权范围' }));
  return screen.getAllByRole('checkbox');
}

describe('ScopeSelector', () => {
  test('a top-level department is a grant of its own, not the whole company', () => {
    const { onChange } = renderPicker();
    const boxes = openPicker();
    // Checkbox 0 is the synthetic 全公司 row; 1..4 are the departments in
    // tree order.
    expect(screen.getByRole('checkbox', { name: '全公司' })).not.toBeChecked();
    fireEvent.click(boxes[1]);
    expect(onChange).toHaveBeenCalledWith({ allCompany: false, deptIds: ['d1'], userIds: [] });
  });

  test('checking one top-level department does not check its sibling', () => {
    const { onChange } = renderPicker();
    const boxes = openPicker();
    fireEvent.click(boxes[1]);
    // Only 产品部 is granted — 研发部 must not ride along.
    expect(onChange).toHaveBeenCalledWith({ allCompany: false, deptIds: ['d1'], userIds: [] });
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ deptIds: expect.arrayContaining(['d1', 'd2']) }),
    );
  });

  test('unchecking one top-level department keeps the other one', () => {
    const { onChange } = renderPicker({ allCompany: false, deptIds: ['d1', 'd2'], userIds: [] });
    const boxes = openPicker();
    fireEvent.click(boxes[1]);
    // 产品部 goes, 研发部 stays.
    expect(onChange).toHaveBeenCalledWith({ allCompany: false, deptIds: ['d2'], userIds: [] });
  });

  test('picking a member keeps the selected departments', () => {
    const { onChange } = renderPicker({ allCompany: false, deptIds: ['d1'], userIds: [] });
    openPicker();
    fireEvent.click(screen.getByText('张三'));
    expect(onChange).toHaveBeenCalledWith({ allCompany: false, deptIds: ['d1'], userIds: ['u1'] });
  });

  test('picking a department keeps the selected members', () => {
    const { onChange } = renderPicker({ allCompany: false, deptIds: [], userIds: ['u1'] });
    const boxes = openPicker();
    fireEvent.click(boxes[1]);
    expect(onChange).toHaveBeenCalledWith({ allCompany: false, deptIds: ['d1'], userIds: ['u1'] });
  });

  test('the whole-company grant does not clear departments or members', () => {
    const { onChange } = renderPicker({ allCompany: false, deptIds: ['d1'], userIds: ['u1'] });
    openPicker();
    fireEvent.click(screen.getByRole('checkbox', { name: '全公司' }));
    expect(onChange).toHaveBeenCalledWith({ allCompany: true, deptIds: ['d1'], userIds: ['u1'] });
  });

  test('the member pane is labelled 成员, not 成员例外', () => {
    renderPicker();
    openPicker();
    expect(screen.getByText('成员')).toBeInTheDocument();
    expect(screen.queryByText(/例外/)).not.toBeInTheDocument();
  });

  test('every grant shows as its own chip', () => {
    renderPicker({ allCompany: true, deptIds: ['d1'], userIds: ['u1'] });
    expect(screen.getByRole('button', { name: '全公司' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '产品部' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '张三' })).toBeInTheDocument();
  });
});
