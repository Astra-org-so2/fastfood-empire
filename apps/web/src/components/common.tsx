import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Badge, cx, Panel, StatusDot, type Tone } from '@aido/ui';
import type { AgentId } from '@aido/types';
import { useProjects } from '../lib/api.js';

/**
 * Small presentation pieces shared by every screen: a page header, status vocabulary and
 * a key/value list. Centralising them is what keeps the product looking like one tool
 * instead of fifteen screens that each invent their own badge.
 */

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-0.5 text-[11px] text-faint">{breadcrumb}</div> : null}
        <h1 className="truncate text-[15px] font-semibold leading-5">{title}</h1>
        {subtitle ? <div className="mt-0.5 text-[12px] text-muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

const TASK_STATUS_TONE: Record<string, Tone> = {
  backlog: 'neutral',
  blocked: 'unknown',
  queued: 'neutral',
  ready: 'accent',
  in_progress: 'accent',
  running: 'accent',
  in_review: 'accent',
  paused: 'warn',
  done: 'free',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
};

const TASK_STATUS_LABEL: Record<string, string> = {
  in_progress: 'running',
  running: 'running',
};

export function TaskStatusBadge({ status }: { status: string }): ReactNode {
  const tone = TASK_STATUS_TONE[status] ?? 'neutral';
  const pulse = status === 'running' || status === 'in_progress';
  return (
    <Badge tone={tone}>
      {pulse ? <StatusDot tone={tone} pulse /> : null}
      {TASK_STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}
    </Badge>
  );
}

const AGENT_TONE: Record<string, Tone> = {
  idle: 'unknown',
  ready: 'neutral',
  working: 'accent',
  executing: 'accent',
  reviewing: 'accent',
  waiting_approval: 'warn',
  blocked: 'danger',
  paused: 'warn',
  error: 'danger',
  failed: 'danger',
  offline: 'unknown',
};

export function AgentStateBadge({ state, paused }: { state: string | undefined; paused?: boolean }): ReactNode {
  if (paused) return <Badge tone="warn">paused</Badge>;
  const key = state ?? 'idle';
  return <Badge tone={AGENT_TONE[key] ?? 'neutral'}>{key.replace(/_/g, ' ')}</Badge>;
}

const PROJECT_TONE: Record<string, Tone> = {
  draft: 'neutral',
  planning: 'accent',
  building: 'accent',
  reviewing: 'warn',
  done: 'free',
  blocked: 'danger',
  archived: 'unknown',
  failed: 'danger',
};

export function ProjectStatusBadge({ status }: { status: string }): ReactNode {
  return <Badge tone={PROJECT_TONE[status] ?? 'neutral'}>{status}</Badge>;
}

const HEALTH_TONE: Record<string, Tone> = {
  online: 'free',
  degraded: 'warn',
  offline: 'danger',
  unconfigured: 'unknown',
  disabled: 'unknown',
  unknown: 'unknown',
};

export function healthTone(status: string | undefined): Tone {
  return HEALTH_TONE[status ?? 'unknown'] ?? 'unknown';
}

/** Credential state wording, kept identical in the list and the detail screen. */
export function credentialLabel(state: string | undefined): { label: string; tone: Tone } {
  switch (state) {
    case 'valid':
      return { label: 'valid', tone: 'free' };
    case 'invalid':
      return { label: 'rejected', tone: 'danger' };
    case 'unverified':
      return { label: 'unverified', tone: 'warn' };
    default:
      return { label: 'not configured', tone: 'warn' };
  }
}

/**
 * Links to an agent's page.
 *
 * `agentId` is nullable because not every record has one: a system-generated message or a
 * commit made outside an agent run has no author role, and those must render as such
 * rather than crashing the screen that lists them.
 */
export function AgentLink({ agentId, name }: { agentId: AgentId | string | null | undefined; name?: string }): ReactNode {
  if (!agentId) return <span className="text-faint">system</span>;
  return (
    <Link to={`/agents/${agentId}`} className="inline-flex items-center gap-1 text-accent hover:underline">
      {name ?? String(agentId).replace(/_/g, ' ')}
      <ArrowRight className="size-3" />
    </Link>
  );
}

export function KeyValue({ items, columns = 2 }: { items: { label: ReactNode; value: ReactNode; title?: string }[]; columns?: 1 | 2 | 3 }): ReactNode {
  const cols = { 1: 'grid-cols-1', 2: 'grid-cols-1 md:grid-cols-2', 3: 'grid-cols-1 md:grid-cols-3' }[columns];
  return (
    <dl className={cx('grid gap-x-4 gap-y-1.5', cols)}>
      {items.map((item, index) => (
        <div key={index} className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wide text-faint">{item.label}</dt>
          <dd className="min-w-0 break-words text-[12px] text-ink" title={item.title}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, actions, children, className, bodyClassName }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }): ReactNode {
  return (
    <Panel className={className}>
      <div className="panel-header">
        <div className="truncate">{title}</div>
        {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
      </div>
      <div className={cx('min-w-0', bodyClassName)}>{children}</div>
    </Panel>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <span className={cx('tabular text-[11px] text-muted', className)}>{children}</span>;
}

export function TimeAgo({ iso }: { iso: string | null | undefined }): ReactNode {
  if (!iso) return <span className="text-faint">never</span>;
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const label = diff < 60_000 ? `${Math.max(1, Math.round(diff / 1000))}s ago` : diff < 3_600_000 ? `${Math.round(diff / 60_000)}m ago` : diff < 86_400_000 ? `${Math.round(diff / 3_600_000)}h ago` : `${Math.round(diff / 86_400_000)}d ago`;
  return (
    <span className="text-faint" title={date.toLocaleString()}>
      {label}
    </span>
  );
}

/**
 * Project selection for the screens that read project-scoped state (agents, git, tests).
 *
 * A project picker rather than a global "current project" store because the API is
 * explicitly project-scoped and the URL stays the source of truth for project routes.
 */
export function ProjectPicker({
  value,
  onChange,
  className,
  label = 'Project',
}: {
  value: string | null;
  onChange: (projectId: string) => void;
  className?: string;
  label?: string;
}): ReactNode {
  const projects = useProjects();
  const list = projects.data ?? [];
  if (list.length === 0) return null;
  return (
    <label className={cx('flex items-center gap-1.5 text-[11px] text-muted', className)}>
      <span className="sr-only">{label}</span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 max-w-[240px] rounded-[var(--radius-sm)] border border-line bg-inset px-2 text-[12px] text-ink"
        title={label}
        aria-label={label}
      >
        <option value="">all projects</option>
        {list.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Selected project for a screen: user choice, else the first project, else null.
 * Returns `undefined` while the list is still loading so callers can distinguish
 * "no project exists" from "not loaded yet".
 */
export function useProjectSelection(): [string | null, (projectId: string) => void, { isLoading: boolean; isEmpty: boolean }] {
  const projects = useProjects();
  const [chosen, setChosen] = useState<string | null>(null);
  const list = projects.data ?? [];
  const exists = chosen !== null && list.some((project) => project.id === chosen);
  const selected = exists ? chosen : list[0]?.id ?? null;
  return [
    selected,
    setChosen,
    { isLoading: projects.isLoading, isEmpty: Boolean(projects.data) && list.length === 0 },
  ];
}
