import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, ErrorState, formatDateTime, formatDuration, formatNumber, formatPercent, formatTokens, LoadingRows, Panel, Stat, StatusDot } from '@aido/ui';
import { useAgent, useAgentActions, useTraces } from '../lib/api.js';
import { AgentStateBadge, KeyValue, Mono, ProjectPicker, Section, TaskStatusBadge, TimeAgo, useProjectSelection } from '../components/common.js';

/**
 * Agent detail (§39): what this role is, what it is allowed to do, and what it did.
 *
 * The system prompt is shown in full. It is configuration, not hidden reasoning — the
 * product's rule is that chain-of-thought is never exposed, and instructions are not
 * chain-of-thought. The model's reasoning is not stored anywhere and is not shown.
 */
export function AgentDetail(): ReactNode {
  const { agentId } = useParams<{ agentId: string }>();
  const [projectId, setProjectId, projects] = useProjectSelection();
  const agent = useAgent(agentId, projectId);
  const traces = useTraces({ agentId, limit: 50 });
  const actions = useAgentActions(projectId);
  const navigate = useNavigate();

  if (agent.isLoading) return <LoadingRows rows={8} />;
  if (agent.error) return <ErrorState title="Agent could not be loaded" detail={(agent.error as Error).message} retry={() => void agent.refetch()} />;
  const data = agent.data!;
  const role = data.role;
  const stats = data.stats;
  const paused = Boolean(data.state?.paused);

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3">
        <button type="button" onClick={() => navigate('/agents')} className="text-[11px] text-accent hover:underline">
          ← Agents
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-[15px] font-semibold">
            {role.name}
            <AgentStateBadge state={data.state?.state} paused={paused} />
          </h1>
          <p className="mt-0.5 max-w-3xl text-[12px] text-muted">{role.tagline}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {projects.isLoading ? null : projects.isEmpty ? null : <ProjectPicker value={projectId} onChange={setProjectId} />}
          {role.id !== 'supervisor' ? (
            <Button
              variant={paused ? 'primary' : 'default'}
              disabled={!projectId}
              title={projectId ? undefined : 'Select a project: agent state is stored per project'}
              loading={actions.pause.isPending || actions.resume.isPending}
              onClick={() => (paused ? actions.resume.mutate({ agentId: role.id }) : actions.pause.mutate({ agentId: role.id }))}
            >
              {paused ? 'Resume agent' : 'Pause agent'}
            </Button>
          ) : null}
          <Link to="/settings" className="text-[11px] text-accent hover:underline">
            team settings
          </Link>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-4">
        <Panel>
          <Stat label="Tasks completed" value={stats.tasksCompleted} tone={stats.tasksCompleted ? 'positive' : 'muted'} />
        </Panel>
        <Panel>
          <Stat label="Tasks failed" value={stats.tasksFailed} tone={stats.tasksFailed ? 'danger' : 'muted'} hint={`${stats.retries} retr${stats.retries === 1 ? 'y' : 'ies'}`} />
        </Panel>
        <Panel>
          <Stat label="Average duration" value={stats.avgDurationMs ? formatDuration(stats.avgDurationMs) : '—'} />
        </Panel>
        <Panel>
          <Stat
            label="Tokens used"
            value={formatTokens(stats.tokensIn + stats.tokensOut)}
            hint={stats.tokenEfficiency !== null ? `${formatNumber(stats.tokenEfficiency, { digits: 2 })} output tokens per input token` : `${formatTokens(stats.tokensIn)} in / ${formatTokens(stats.tokensOut)} out`}
          />
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Section title="Role" className="lg:col-span-2">
          <div className="space-y-3 px-3 py-2.5 text-[12px]">
            <p className="text-muted">{role.responsibility}</p>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Responsibilities</div>
              <ul className="space-y-0.5 text-muted">
                {role.responsibilities.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Model preference</div>
                <KeyValue
                  columns={1}
                  items={[
                    { label: 'Required capabilities', value: role.modelPreference.requiredCapabilities.join(', ') || 'none' },
                    { label: 'Preferred', value: role.modelPreference.preferCapabilities.join(', ') || 'none' },
                    { label: 'Minimum context', value: `${formatTokens(role.modelPreference.minContextWindow)} tokens` },
                    { label: 'Quality requirement', value: role.modelPreference.qualityRequirement },
                    { label: 'Latency ceiling', value: role.modelPreference.maxLatencyMs ? `${role.modelPreference.maxLatencyMs} ms` : 'none' },
                    { label: 'May use trial credits', value: role.modelPreference.allowTrialCredits ? 'yes' : 'no' },
                  ]}
                />
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Hard limits</div>
                <KeyValue
                  columns={1}
                  items={[
                    { label: 'Max tokens per task', value: formatTokens(role.limits.maxTokens) },
                    { label: 'Max requests per task', value: role.limits.maxRequests },
                    { label: 'Max runtime', value: formatDuration(role.limits.maxRuntimeMs) },
                    { label: 'Max retries', value: role.limits.maxRetries },
                    { label: 'Max files changed', value: role.limits.maxFilesChanged },
                    { label: 'Max shell commands', value: role.limits.maxShellCommands },
                  ]}
                />
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Tools</div>
              <div className="flex flex-wrap gap-1">
                {role.tools.map((tool) => (
                  <Badge key={tool} tone="neutral">
                    {tool}
                  </Badge>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-faint">
                A tool outside this list is refused by the runtime, not ignored by the prompt.
              </p>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Handled task types</div>
              <div className="flex flex-wrap gap-1">
                {role.handledTaskTypes.map((taskType) => (
                  <Badge key={taskType} tone="accent">
                    {taskType.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <div className="space-y-3">
          <Section title="Instructions">
            <pre className="max-h-72 scroll-y whitespace-pre-wrap px-3 py-2 text-[11px] leading-4 text-muted">{role.systemPrompt}</pre>
            <p className="border-t border-line px-3 py-1.5 text-[10px] text-faint">
              These are the agent's instructions (configuration). The model's internal reasoning is never stored or displayed.
            </p>
          </Section>

          <Section title="Current state">
            <div className="px-3 py-2">
              <KeyValue
                columns={1}
                items={[
                  { label: 'State', value: <AgentStateBadge state={data.state?.state} paused={paused} /> },
                  { label: 'Current task', value: data.state?.currentTaskId ? <Mono>{data.state.currentTaskId.slice(0, 8)}</Mono> : 'none' },
                  { label: 'Last active', value: data.state?.lastActiveAt ? formatDateTime(data.state.lastActiveAt) : 'never' },
                  { label: 'Busy time', value: data.busyMs !== null ? formatDuration(data.busyMs) : 'not measured' },
                  { label: 'Output schema', value: <Mono>{role.outputSchema}</Mono> },
                ]}
              />
            </div>
          </Section>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Section title={`Tasks (${data.tasks.length})`}>
          {data.tasks.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-muted">This agent has not been assigned a task yet.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.tasks.slice(0, 40).map((task) => (
                  <tr key={task.id} className="row-hover">
                    <td className="max-w-[320px] truncate">
                      <Link to={`/projects/${task.projectId}/tasks`} className="hover:text-accent">
                        {task.title}
                      </Link>
                    </td>
                    <td>
                      <TaskStatusBadge status={task.status} />
                    </td>
                    <td className="max-w-[180px] truncate">
                      <Mono>{task.lastModelId ?? '—'}</Mono>
                    </td>
                    <td>
                      <TimeAgo iso={task.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Recent model calls">
          {traces.isLoading ? <LoadingRows rows={5} /> : null}
          {(traces.data ?? []).length === 0 && !traces.isLoading ? <div className="px-3 py-4 text-[12px] text-muted">No model call recorded for this agent yet.</div> : null}
          {(traces.data ?? []).length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Model</th>
                  <th>Task type</th>
                  <th>Latency</th>
                  <th>Tokens</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {(traces.data ?? []).map((trace) => (
                  <tr key={trace.traceId} className="row-hover">
                    <td>
                      <TimeAgo iso={trace.startedAt} />
                    </td>
                    <td className="max-w-[220px] truncate">
                      <Mono>{trace.modelId}</Mono>
                    </td>
                    <td>{trace.taskType?.replace(/_/g, ' ') ?? '—'}</td>
                    <td className="tabular">{formatNumber(trace.latencyMs)} ms</td>
                    <td className="tabular">{formatTokens(trace.usage?.totalTokens ?? null)}</td>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        <StatusDot tone={trace.status === 'success' ? 'free' : 'danger'} />
                        {trace.status}
                        {trace.failoverDepth ? <span className="text-[10px] text-faint">failover ×{trace.failoverDepth}</span> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Section>
      </div>

      <div className="mt-3 text-[11px] text-faint">
        Success rate for this agent: {stats.tasksCompleted + stats.tasksFailed > 0 ? formatPercent(stats.tasksCompleted / (stats.tasksCompleted + stats.tasksFailed)) : 'not enough data'}
      </div>
    </div>
  );
}
