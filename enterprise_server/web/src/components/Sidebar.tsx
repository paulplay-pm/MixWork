import {
  BarChart3,
  Bot,
  Boxes,
  Building2,
  Fingerprint,
  Key,
  LayoutDashboard,
  Link,
  Plug2,
  ScrollText,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Users,
} from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { useAuth } from '../auth/useAuth';
import { usePermissions } from '../auth/usePermissions';
import { t } from '../i18n';
import { isPermissionPoint } from '../shared/permissions';
import { UserMenu } from './UserMenu';

type Section = 'overview' | 'config' | 'versions' | 'monitor' | 'org' | 'account';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  section: Section;
  /** A coarse role code (`org_admin`) or a fine permission point
   * (`usage:view`). A value containing `:` is a point — see
   * `isPermissionPoint`. */
  requires?: string;
}

// The order of the entries inside a group is the order they are listed here.
const ITEMS: NavItem[] = [
  { to: '/', label: t('nav.dashboard'), icon: <LayoutDashboard />, section: 'overview' },
  { to: '/config/providers', label: t('nav.providersModels'), icon: <Key />, section: 'config', requires: 'model_admin' },
  { to: '/config/mcp-manage', label: t('nav.mcpManage'), icon: <Plug2 />, section: 'config', requires: 'org_admin' },
  { to: '/config/skill', label: t('nav.skill'), icon: <Sparkles />, section: 'config', requires: 'policy_admin' },
  { to: '/config/kits', label: t('nav.kit'), icon: <Boxes />, section: 'config', requires: 'org_admin' },
  { to: '/config/agents', label: t('nav.agents'), icon: <Bot />, section: 'config', requires: 'agent_admin' },
  { to: '/config/versions', label: t('nav.versions'), icon: <UploadCloud />, section: 'versions', requires: 'org_admin' },
  { to: '/monitoring/usage', label: t('nav.usage'), icon: <BarChart3 />, section: 'monitor', requires: 'usage:view' },
  { to: '/monitoring/audit', label: t('nav.audit'), icon: <ScrollText />, section: 'monitor', requires: 'audit:view' },
  { to: '/orgs/users', label: t('nav.users'), icon: <Users />, section: 'org', requires: 'org_admin' },
  { to: '/orgs/departments', label: t('nav.departments'), icon: <Building2 />, section: 'org', requires: 'org_admin' },
  { to: '/orgs/roles', label: t('nav.roles'), icon: <ShieldCheck />, section: 'org', requires: 'org_admin' },
  // The identity provider sits with the org's own structure rather than with
  // the capability catalog: it decides who can sign in, not what they can
  // reach once signed in.
  { to: '/config/sso', label: t('nav.sso'), icon: <Fingerprint />, section: 'org', requires: 'org_admin' },
  { to: '/account/sso-bindings', label: t('ssoBindings.title'), icon: <Link />, section: 'account' },
];

const SECTION_LABEL: Record<Section, string> = {
  overview: t('nav.groups.overview'),
  config: t('nav.groups.config'),
  versions: t('nav.groups.versions'),
  monitor: t('nav.groups.monitor'),
  org: t('nav.groups.org'),
  account: t('nav.groups.account'),
};

const SECTION_ORDER: Section[] = ['overview', 'config', 'versions', 'monitor', 'org', 'account'];

export function Sidebar(): JSX.Element {
  const { hasCapability } = useAuth();
  const { hasPermission, loading } = usePermissions();
  const visible = ITEMS.filter((i) => {
    if (!i.requires) return true;
    // A point-gated item is HIDDEN until `/me` resolves rather than shown and
    // then pulled: an empty permission set reads as "denied", and a nav entry
    // that appears then vanishes is worse than one that arrives a moment late.
    // The coarse role path is synchronous and never waits.
    if (isPermissionPoint(i.requires)) return !loading && hasPermission(i.requires);
    return hasCapability(i.requires);
  });
  const grouped = SECTION_ORDER
    .map((sec) => ({ sec, items: visible.filter((i) => i.section === sec) }))
    .filter((g) => g.items.length > 0);

  return (
    <aside className="w-[220px] border-r border-[var(--border-subtle)] bg-white flex flex-col flex-shrink-0">
      <div className="px-5 pt-5 pb-4 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5">
          <img
            src="/brand/mixwork-small.png"
            alt=""
            draggable={false}
            className="w-8 h-8 rounded-[var(--radius-md)] object-contain"
          />
          <div className="font-semibold text-[15px] text-[var(--text-primary)] tracking-tight">
            {t('sidebar.brandName')}
          </div>
        </div>
      </div>
      <nav className="flex-1 py-3 px-3 overflow-y-auto space-y-4">
        {grouped.map(({ sec, items }) => (
          <div key={sec}>
            <div className="text-[11px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider px-3 pt-2 pb-1.5">
              {SECTION_LABEL[sec]}
            </div>
            {items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-sm)] text-[13.5px] transition-colors mb-0.5 ${
                    isActive
                      ? 'bg-[var(--accent-light)] text-[var(--accent-primary)] font-semibold'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] font-medium'
                  }`
                }
              >
                <span className="w-[18px] h-[18px] flex-shrink-0 [&_svg]:w-[18px] [&_svg]:h-[18px]">{i.icon}</span>
                {i.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <UserMenu />
    </aside>
  );
}
