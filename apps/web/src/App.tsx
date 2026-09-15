import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertOctagon,
  BarChart3,
  Boxes,
  Cpu,
  FlaskConical,
  GitBranch,
  LayoutDashboard,
  ListTree,
  Plug,
  Settings as SettingsIcon,
  ShieldCheck,
  Users,
  WifiOff,
} from 'lucide-react';
import { Badge, Button, cx, QuotaTypeBadge, StatusDot } from '@aido/ui';
import { useApprovals, useDashboard, useHealth, useLiveEvents, useSettings, useSettingsMutation } from './lib/api.js';
import { Dashboard } from './screens/Dashboard.js';
import { Projects } from './screens/Projects.js';
import { ProjectDetail } from './screens/ProjectDetail.js';
import { Agents } from './screens/Agents.js';
import { AgentDetail } from './screens/AgentDetail.js';
import { Providers } from './screens/Providers.js';
import { ProviderDetail } from './screens/ProviderDetail.js';
import { Models } from './screens/Models.js';
import { Quotas } from './screens/Quotas.js';
import { ActivityScreen } from './screens/Activity.js';
import { GitScreen } from './screens/Git.js';
import { TestsScreen } from './screens/Tests.js';
import { Performance } from './screens/Performance.js';
import { SettingsScreen } from './screens/Settings.js';
import { ApprovalBar } from './components/ApprovalBar.js';

/**
 * The application shell (§39, §54).
 *
 * One shell for both deployments: this exact tree is what the browser renders and what
 * the Electron window loads. Navigation, the FREE ONLY indicator, the approval bar and
 * the live-connection state are therefore identical in both.
 */

interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  /** Match nested routes (project detail). */
  prefix?: boolean;
  badge?: number;
}

export function App(): ReactNode {
  const { state: streamState } = useLiveEvents();
  const health = useHealth();
  const dashboard = useDashboard();
  const approvals = useApprovals();
  const settings = useSettings();

  const approvalCount = approvals.data?.length ?? 0;
  const running = dashboard.data?.runs.active ?? 0;

  const sections: { label: string; entries: NavEntry[] }[] = useMemo(
    () => [
      {
        label: 'Work',
        entries: [
          { to: '/', label: 'Dashboard', icon: <LayoutDashboard className="size-3.5" /> },
          { to: '/projects', label: 'Projects', icon: <Boxes className="size-3.5" />, prefix: true },
          { to: '/tasks', label: 'Tasks', icon: <ListTree className="size-3.5" /> },
          { to: '/git', label: 'Git', icon: <GitBranch className="size-3.5" /> },
          { to: '/tests', label: 'Tests', icon: <FlaskConical className="size-3.5" /> },
        ],
      },
      {
        label: 'Team',
        entries: [
          { to: '/agents', label: 'Agents', icon: <Users className="size-3.5" />, prefix: true },
          { to: '/activity', label: 'Activity', icon: <Activity className="size-3.5" />, badge: approvalCount },
        ],
      },
      {
        label: 'Providers',
        entries: [
          { to: '/providers', label: 'Providers', icon: <Plug className="size-3.5" />, prefix: true },
          { to: '/models', label: 'Models', icon: <Cpu className="size-3.5" /> },
          { to: '/quotas', label: 'Quotas', icon: <ShieldCheck className="size-3.5" /> },
        ],
      },
      {
        label: 'Insight',
        entries: [
          { to: '/performance', label: 'Performance', icon: <BarChart3 className="size-3.5" /> },
          { to: '/settings', label: 'Settings', icon: <SettingsIcon className="size-3.5" /> },
        ],
      },
    ],
    [approvalCount],
  );

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar sections={sections} running={running} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar streamState={streamState} healthOk={health.data?.ok} version={health.data?.version} freeOnly={settings.data?.settings.freeOnlyMode ?? false} />
        <ApprovalBar />
        <main className="min-w-0 flex-1 scroll-y px-4 py-3">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId/*" element={<ProjectDetail />} />
            <Route path="/tasks" element={<AllTasks />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/:agentId" element={<AgentDetail />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/providers/:providerId" element={<ProviderDetail />} />
            <Route path="/models" element={<Models />} />
            <Route path="/quotas" element={<Quotas />} />
            <Route path="/activity" element={<ActivityScreen />} />
            <Route path="/git" element={<GitScreen />} />
            <Route path="/tests" element={<TestsScreen />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Sidebar({ sections, running }: { sections: { label: string; entries: NavEntry[] }[]; running: number }): ReactNode {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-11 items-center gap-2 border-b border-line px-3">
        <div className="grid size-5 place-items-center rounded-[var(--radius-sm)] bg-accent text-[11px] font-bold text-accent-ink">AI</div>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold leading-4">Dev Orchestrator</div>
          <div className="truncate text-[10px] leading-3 text-faint">multi-provider agent team</div>
        </div>
      </div>
      <nav className="flex-1 scroll-y px-1.5 py-2">
        {sections.map((section) => (
          <div key={section.label} className="mb-3">
            <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{section.label}</div>
            <div className="space-y-0.5">
              {section.entries.map((entry) => (
                <NavLink
                  key={entry.to}
                  to={entry.to}
                  end={!entry.prefix}
                  className={({ isActive }) =>
                    cx(
                      'flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-[5px] text-[12px] transition-colors',
                      isActive ? 'bg-accent-soft/60 text-ink' : 'text-muted hover:bg-hover hover:text-ink',
                    )
                  }
                >
                  {entry.icon}
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.badge ? (
                    <span className="rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">{entry.badge}</span>
                  ) : null}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-line px-3 py-2 text-[11px] text-faint">
        {running > 0 ? (
          <span className="flex items-center gap-1.5 text-free">
            <StatusDot tone="free" pulse /> {running} run{running === 1 ? '' : 's'} active
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <StatusDot tone="unknown" /> idle
          </span>
        )}
      </div>
    </aside>
  );
}

function TopBar({
  streamState,
  healthOk,
  version,
  freeOnly,
}: {
  streamState: 'connecting' | 'open' | 'closed';
  healthOk: boolean | undefined;
  version: string | undefined;
  freeOnly: boolean;
}): ReactNode {
  const settingsMutation = useSettingsMutation();
  const isDesktop = typeof window !== 'undefined' && Boolean(window.aido);

  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-muted" title={streamState === 'open' ? 'Live updates are streaming' : 'Live updates are reconnecting'}>
          {streamState === 'open' ? <StatusDot tone="free" pulse /> : <WifiOff className="size-3 text-warn" />}
          {streamState === 'open' ? 'live' : streamState === 'connecting' ? 'connecting…' : 'reconnecting…'}
        </span>
        {healthOk === false ? (
          <Badge tone="danger" title="The API reports a degraded subsystem; see Settings → Diagnostics">
            <AlertOctagon className="size-3" /> degraded
          </Badge>
        ) : null}
        {version ? <span className="text-[11px] text-faint">v{version}</span> : null}
        {isDesktop ? <Badge tone="accent" title="Running inside the Linux desktop shell">desktop</Badge> : null}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5" title="FREE ONLY mode restricts every request to renewable free quota: no paid models, no trial credits.">
          <StatusDot tone={freeOnly ? 'free' : 'unknown'} />
          <span className="text-[11px] text-muted">FREE ONLY</span>
          <Button
            variant={freeOnly ? 'primary' : 'default'}
            onClick={() => settingsMutation.mutate({ freeOnlyMode: !freeOnly })}
            loading={settingsMutation.isPending}
            aria-pressed={freeOnly}
          >
            {freeOnly ? 'on' : 'off'}
          </Button>
        </div>
        <QuotaTypeBadge type={freeOnly ? 'free_renewable' : 'unknown'} />
      </div>
    </header>
  );
}

/** The task board across every project, for when the operator is not inside one. */
function AllTasks(): ReactNode {
  const navigate = useNavigate();
  const { data } = useDashboard();
  const projects = data?.projects ?? [];

  useEffect(() => {
    // A single project with no project selected: go straight to its board.
    if (projects.length === 1) navigate(`/projects/${projects[0]!.id}/tasks`, { replace: true });
  }, [navigate, projects]);

  return (
    <div className="mx-auto max-w-3xl py-6">
      <h1 className="text-[15px] font-semibold">Tasks</h1>
      <p className="mt-1 text-[12px] text-muted">Pick a project to see its kanban and dependency graph.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {projects.map((project) => (
          <Button key={project.id} onClick={() => navigate(`/projects/${project.id}/tasks`)}>
            {project.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

export default App;

/** Used by screens that need the project id from the route. */
export function useProjectParam(): string | undefined {
  const params = useParams<{ projectId?: string }>();
  return params.projectId;
}
