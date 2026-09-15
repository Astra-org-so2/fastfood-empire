import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowRight, Info, Plus } from 'lucide-react';
import { Badge, Button, cx, ErrorState, formatNumber, formatPercent, formatRelativeTime, formatTokens, LoadingRows, Panel, QuotaTypeBadge, Stat, StatusDot } from '@aido/ui';
import { useDashboard, useHealth } from '../lib/api.js';
import { PageHeader, ProjectStatusBadge, Section, TimeAgo } from '../components/common.js';

/**
 * Dashboard: what is running, what is blocked, how much free quota is left, and what
 * needs a human. Deliberately dense — the operator should be able to answer "is anything
 * wrong?" in one screen without scrolling.
 */
export function Dashboard(): ReactNode {
  const dashboard = useDashboard();
  const health = useHealth();
  const navigate = useNavigate();

  if (dashboard.isLoading) return <LoadingRows rows={8} />;
  if (dashboard.error) return <ErrorState title="The dashboard could not be loaded" detail={(dashboard.error as Error).message} retry={() => void dashboard.refetch()} />;
  const data = dashboard.data!;

  const activeProjects = data.projects.filter((project) => project.runState === 'running');
  const freeQuota = data.providers.filter((provider) => provider.freeTier?.quotaType === 'free_renewable' && provider.enabled);

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Dashboard"
        subtitle={`${data.projects.length} project${data.projects.length === 1 ? '' : 's'} · usage since ${formatRelativeTime(data.usage.since)}`}
        actions={
          <>
            <Button icon={<Plus className="size-3.5" />} onClick={() => navigate('/projects?new=1')}>
              New project
            </Button>
            <Button variant="ghost" onClick={() => void health.refetch()}>
              Refresh
            </Button>
          </>
        }
      />

      {data.providers.length > 0 && data.providers.every((provider) => !provider.enabled) ? (
        <div className="mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-accent/40 bg-accent-soft/20 px-2.5 py-2 text-[12px] text-ink">
          <Info className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
          <span>
            No provider is enabled yet, so nothing can run. Add an API key on{' '}
            <Link to="/providers" className="font-medium text-accent underline decoration-dotted">
              Providers
            </Link>{' '}
            — free tiers are detected and tracked automatically, and FREE ONLY mode keeps every request inside them.
          </span>
        </div>
      ) : null}

      {data.warnings.length ? (
        <div className="mb-3 space-y-1.5">
          {data.warnings.map((warning, index) => (
            <div
              key={`${warning.providerId ?? 'system'}-${index}`}
              className={cx(
                'flex items-start gap-2 rounded-[var(--radius-md)] border px-2.5 py-1.5 text-[12px]',
                warning.level === 'error' ? 'border-danger/40 bg-danger/5 text-danger' : 'border-warn/40 bg-warn/5 text-warn',
              )}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                {warning.providerId ? (
                  <Link to={`/providers/${warning.providerId}`} className="mr-1.5 font-medium underline decoration-dotted">
                    {warning.providerId}
                  </Link>
                ) : null}
                {warning.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-4">
        <Panel>
          <Stat label="Active runs" value={data.runs.active} hint={data.runs.projectIds.map((id) => data.projects.find((project) => project.id === id)?.name ?? id.slice(0, 8)).join(', ') || 'nothing running'} tone={data.runs.active ? 'positive' : 'muted'} />
        </Panel>
        <Panel>
          <Stat label="Requests (7d)" value={formatNumber(data.usage.requests)} hint={`${formatTokens(data.usage.tokensIn)} in / ${formatTokens(data.usage.tokensOut)} out`} />
        </Panel>
        <Panel>
          <Stat
            label="Success rate"
            value={formatPercent(data.usage.successRate)}
            hint={`${data.usage.failovers} failover${data.usage.failovers === 1 ? '' : 's'} · avg ${formatNumber(data.usage.avgLatencyMs)} ms`}
            tone={data.usage.successRate >= 0.95 ? 'positive' : data.usage.successRate >= 0.8 ? 'warning' : 'danger'}
          />
        </Panel>
        <Panel>
          <Stat
            label="Approvals waiting"
            value={data.approvals.length}
            hint={data.approvals.length ? 'agents are blocked until you decide' : 'nothing needs a decision'}
            tone={data.approvals.length ? 'warning' : 'muted'}
          />
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Section
          title="Projects"
          className="lg:col-span-2"
          actions={
            <Link to="/projects" className="text-[11px] text-accent hover:underline">
              all projects
            </Link>
          }
        >
          {data.projects.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">
              No projects yet. Create one and the team will plan it, build it and review it.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Tasks</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.projects.map((project) => {
                  const counts = (project as { counts?: Record<string, number> }).counts ?? {};
                  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
                  const done = counts.done ?? 0;
                  return (
                    <tr key={project.id} className="row-hover">
                      <td>
                        <Link to={`/projects/${project.id}`} className="text-ink hover:text-accent">
                          {project.name}
                        </Link>
                        {project.runState === 'running' ? (
                          <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-free">
                            <StatusDot tone="free" pulse /> running
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <ProjectStatusBadge status={project.status} />
                      </td>
                      <td className="tabular">
                        {done}/{total || '—'}
                      </td>
                      <td>
                        <TimeAgo iso={project.updatedAt} />
                      </td>
                      <td className="text-right">
                        <Link to={`/projects/${project.id}/tasks`} className="text-accent hover:underline">
                          board
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Section>

        <Section
          title="Free quota"
          actions={
            <Link to="/quotas" className="text-[11px] text-accent hover:underline">
              details
            </Link>
          }
        >
          <div className="space-y-2 px-3 py-2">
            {freeQuota.length === 0 ? (
              <div className="text-[12px] text-muted">
                No provider with renewable free quota is enabled. Add a provider or enable one under Providers.
              </div>
            ) : (
              freeQuota.map((provider) => (
                <div key={provider.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-ink">{provider.name}</div>
                    <div className="text-[11px] text-faint">
                      {provider.health.status}
                      {provider.freeTier?.resetStrategy ? ` · reset ${provider.freeTier.resetStrategy.replace(/_/g, ' ')}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {provider.credentialStatus.state === 'valid' ? null : <Badge tone="warn">{provider.credentialStatus.state}</Badge>}
                    <QuotaTypeBadge type={provider.freeTier?.quotaType ?? 'unknown'} />
                  </div>
                </div>
              ))
            )}
            <div className="border-t border-line pt-2 text-[11px] text-faint">
              {data.reservations.open} open reservation{data.reservations.open === 1 ? '' : 's'} · {data.reservations.expired} expired. Reservations are what stops two agents from
              planning to use the same remaining requests.
            </div>
          </div>
        </Section>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Section
          title="Recent activity"
          className="lg:col-span-2"
          actions={
            <Link to="/activity" className="text-[11px] text-accent hover:underline">
              full log
            </Link>
          }
        >
          <ul className="divide-y divide-line/40">
            {data.recentEvents.slice(0, 12).map((event, index) => (
              <li key={`${event.at}-${index}`} className="flex items-start gap-2 px-3 py-1.5">
                <StatusDot tone={event.severity === 'error' ? 'danger' : event.severity === 'warning' ? 'warn' : 'unknown'} />
                <span className="min-w-0 flex-1 text-[12px] text-muted">{event.message}</span>
                <TimeAgo iso={event.at} />
              </li>
            ))}
            {data.recentEvents.length === 0 ? <li className="px-3 py-4 text-center text-[12px] text-muted">Nothing has happened yet.</li> : null}
          </ul>
        </Section>

        <Section title="Runtime">
          <div className="px-3 py-2 text-[12px] text-muted">
            {health.data ? (
              <ul className="space-y-1">
                <li className="flex justify-between gap-2">
                  <span>State</span>
                  <span className={health.data.ok ? 'text-free' : 'text-danger'}>{health.data.ok ? 'ok' : 'degraded'}</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span>Uptime</span>
                  <span className="tabular">{Math.round(health.data.uptimeSeconds / 60)} min</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span>Database</span>
                  <span className="tabular">{formatNumber(health.data.database.bytes / 1024, { digits: 0 })} KiB</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span>Schema</span>
                  <span className="tabular">v{health.data.database.migrations.version}</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span>Shell</span>
                  <span>{health.data.shell.kind}</span>
                </li>
              </ul>
            ) : (
              <LoadingRows rows={3} />
            )}
          </div>
        </Section>
      </div>

      <div className="mt-3">
        <Section
          title="Providers"
          actions={
            <Link to="/providers" className="text-[11px] text-accent hover:underline">
              manage
            </Link>
          }
        >
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Class</th>
                  <th>Credentials</th>
                  <th>Health</th>
                  <th>Models</th>
                  <th>Free models</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.providers.map((provider) => (
                  <tr key={provider.id} className="row-hover">
                    <td>
                      <Link to={`/providers/${provider.id}`} className="text-ink hover:text-accent">
                        {provider.name}
                      </Link>
                      {!provider.enabled ? <span className="ml-2 text-[10px] text-faint">disabled</span> : null}
                    </td>
                    <td>
                      <QuotaTypeBadge type={provider.freeTier?.quotaType ?? null} />
                    </td>
                    <td>
                      <span className={provider.credentialStatus.state === 'valid' ? 'text-free' : 'text-warn'}>{provider.credentialStatus.state}</span>
                      {provider.credentialStatus.detail ? <div className="text-[10px] text-faint">{provider.credentialStatus.detail}</div> : null}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone={provider.health.status === 'online' ? 'free' : provider.health.status === 'unconfigured' ? 'unknown' : provider.health.status === 'degraded' ? 'warn' : 'danger'} />
                        {provider.health.status}
                      </span>
                      {provider.health.latencyMs !== null ? <span className="ml-1 tabular text-[10px] text-faint">{provider.health.latencyMs} ms</span> : null}
                    </td>
                    <td className="tabular">{provider.modelCount}</td>
                    <td className="tabular">{provider.freeModelCount}</td>
                    <td className="text-right">
                      <Link to={`/providers/${provider.id}`} className="inline-flex items-center gap-1 text-accent hover:underline">
                        open <ArrowRight className="size-3" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-faint">
        <Activity className="size-3" />
        Live updates arrive over server-sent events; the header shows the connection state.
      </div>
    </div>
  );
}
