import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Pause, Play, UserCog } from 'lucide-react';
import { AgentStateBadge, ProjectPicker, useProjectSelection } from '../components/common.js';
import { Badge, Button, cx, ErrorState, formatDuration, formatNumber, formatTokens, LoadingRows, Panel, ProgressBar } from '@aido/ui';
import { useAgentActions, useAgents } from '../lib/api.js';

/**
 * The team (§14, §39).
 *
 * Every role is visible with what it is for, which model class it asks for, which tools
 * it may use and what it has actually done — the last part matters most, because a role
 * that has never completed a task is a role the operator may want to disable.
 */
export function Agents(): ReactNode {
  const [projectId, setProjectId, projects] = useProjectSelection();
  const agents = useAgents(projectId ?? undefined);
  const actions = useAgentActions(projectId);
  const [busy, setBusy] = useState<string | null>(null);

  if (agents.isLoading) return <LoadingRows rows={8} />;
  if (agents.error) return <ErrorState title="Agents could not be loaded" detail={(agents.error as Error).message} retry={() => void agents.refetch()} />;
  const list = agents.data ?? [];

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-[15px] font-semibold">Agents</h1>
          <p className="mt-0.5 text-[12px] text-muted">
            {list.length} roles. Each role has its own tools, output schema, model preferences and hard limits. The Supervisor watches them and intervenes when something is stuck.
          </p>
          {projects.isLoading ? null : projects.isEmpty ? (
            <p className="mt-0.5 text-[11px] text-warn">No project exists yet, so there is no agent activity to report — the roster and its configuration are shown below.</p>
          ) : null}
        </div>
        <ProjectPicker value={projectId} onChange={setProjectId} />
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {list.map((agent) => {
          const stats = agent.stats;
          const state = agent.state?.state ?? 'idle';
          const paused = Boolean(agent.state?.paused);
          const isSupervisor = agent.id === 'supervisor';
          const completed = stats?.tasksCompleted ?? 0;
          const failed = stats?.tasksFailed ?? 0;
          const total = completed + failed;

          return (
            <Panel key={agent.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link to={`/agents/${agent.id}`} className="truncate text-[13px] font-medium text-ink hover:text-accent">
                      {agent.name}
                    </Link>
                    <AgentStateBadge state={state} paused={paused} />
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{agent.tagline ?? agent.responsibility}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!isSupervisor ? (
                    paused ? (
                      <Button
                        variant="ghost"
                        icon={<Play className="size-3.5" />}
                        loading={busy === agent.id}
                        title={projectId ? 'Resume this agent' : 'Select a project to change agent state'}
                        onClick={() => {
                          setBusy(agent.id);
                          actions.resume.mutate({ agentId: agent.id }, { onSettled: () => setBusy(null) });
                        }}
                      />
                    ) : (
                      <Button
                        variant="ghost"
                        icon={<Pause className="size-3.5" />}
                        loading={busy === agent.id}
                        title={projectId ? 'Pause this agent: it will not be dispatched new tasks' : 'Select a project to change agent state'}
                        onClick={() => {
                          setBusy(agent.id);
                          actions.pause.mutate({ agentId: agent.id }, { onSettled: () => setBusy(null) });
                        }}
                      />
                    )
                  ) : (
                    <span title="The supervisor coordinates the others and enforces the hard limits">
                      <UserCog className="size-3.5 text-faint" />
                    </span>
                  )}
                </div>
              </div>

              <div className="flex-1 space-y-2 px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {(agent.handledTaskTypes ?? []).slice(0, 4).map((taskType) => (
                    <Badge key={taskType} tone="neutral">
                      {taskType.replace(/_/g, ' ')}
                    </Badge>
                  ))}
                  {(agent.handledTaskTypes ?? []).length > 4 ? <Badge tone="neutral">+{(agent.handledTaskTypes ?? []).length - 4}</Badge> : null}
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                  <Metric label="Completed" value={completed} />
                  <Metric label="Failed" value={failed} tone={failed ? 'danger' : undefined} />
                  <Metric label="Avg duration" value={stats?.avgDurationMs ? formatDuration(stats.avgDurationMs) : '—'} />
                  <Metric label="Tokens" value={formatTokens((stats?.tokensIn ?? 0) + (stats?.tokensOut ?? 0))} />
                </div>
                {total > 0 ? (
                  <div>
                    <div className="mb-0.5 flex justify-between text-[10px] text-faint">
                      <span>success rate</span>
                      <span className="tabular">{formatNumber((completed / total) * 100, { digits: 0 })}%</span>
                    </div>
                    <ProgressBar value={completed / total} tone={completed / total >= 0.9 ? 'free' : completed / total >= 0.6 ? 'warn' : 'danger'} />
                  </div>
                ) : (
                  <div className="text-[11px] text-faint">No tasks completed yet.</div>
                )}

                <div className="flex flex-wrap gap-1 pt-0.5">
                  {(agent.tools ?? []).slice(0, 6).map((tool) => (
                    <span key={tool} className="rounded bg-inset px-1 py-0.5 text-[10px] text-faint" title={`tool: ${tool}`}>
                      {tool}
                    </span>
                  ))}
                  {(agent.tools ?? []).length > 6 ? <span className="text-[10px] text-faint">+{(agent.tools ?? []).length - 6} tools</span> : null}
                </div>
              </div>

              <div className="border-t border-line px-3 py-1.5 text-[11px]">
                <Link to={`/agents/${agent.id}`} className="text-accent hover:underline">
                  open detail →
                </Link>
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: ReactNode; tone?: 'danger' }): ReactNode {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-faint">{label}</span>
      <span className={cx('tabular', tone === 'danger' ? 'text-danger' : 'text-ink')}>{value}</span>
    </div>
  );
}
