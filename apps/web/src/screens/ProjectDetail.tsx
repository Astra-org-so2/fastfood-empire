import { useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ExternalLink, FolderOpen, GitBranch, Play, RotateCcw, Square, Terminal, Wand2 } from 'lucide-react';
import {
  Badge,
  Button,
  cx,
  ErrorState,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelativeTime,
  formatTokens,
  LoadingRows,
  Modal,
  Panel,
  ProgressBar,
  StatusDot,
} from '@aido/ui';
import type { Task } from '@aido/types';
import {
  api,
  useExecutions,
  useGitLog,
  useGitStatus,
  useMemory,
  useMessages,
  usePlatform,
  useProject,
  useProjectActions,
  useProjectFile,
  useProjectFiles,
  useProjectGraph,
  useProjectTasks,
  useSupervision,
  useTests,
  useTraces,
} from '../lib/api.js';
import { AgentStateBadge, AgentLink, KeyValue, Mono, PageHeader, ProjectStatusBadge, Section, TaskStatusBadge, TimeAgo } from '../components/common.js';
import { TaskBoard } from './Tasks.js';
import { DependencyGraph } from './Graph.js';

/**
 * The project workspace: everything about one project behind tabs, because the operator
 * moves between the board, the diff, the tests and the agents constantly and losing the
 * project context on every navigation would be hostile.
 */
export function ProjectDetail(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const project = useProject(projectId);
  const actions = useProjectActions(projectId);
  const navigate = useNavigate();
  const [confirmStop, setConfirmStop] = useState(false);

  if (project.isLoading) return <LoadingRows rows={6} />;
  if (project.error) return <ErrorState title="Project could not be loaded" detail={(project.error as Error).message} retry={() => void project.refetch()} />;
  const data = project.data!;
  const run = data.run;
  const tasks = Object.values(data.counts ?? {}).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  const done = data.counts.done ?? 0;

  const tabs = [
    { to: '', label: 'Overview' },
    { to: 'tasks', label: 'Tasks' },
    { to: 'graph', label: 'Dependency graph' },
    { to: 'files', label: 'Files' },
    { to: 'git', label: 'Git' },
    { to: 'tests', label: 'Tests' },
    { to: 'agents', label: 'Agents' },
    { to: 'memory', label: 'Memory' },
    { to: 'activity', label: 'Activity' },
  ];

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        breadcrumb={
          <span>
            <button type="button" className="text-accent hover:underline" onClick={() => navigate('/projects')}>
              Projects
            </button>{' '}
            / {data.project.name}
          </span>
        }
        title={
          <span className="flex items-center gap-2">
            {data.project.name}
            <ProjectStatusBadge status={data.project.status} />
            {run.running ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-free">
                <StatusDot tone="free" pulse /> running
              </span>
            ) : null}
          </span>
        }
        subtitle={data.project.spec?.goal}
        actions={
          <>
            <Button icon={<Wand2 className="size-3.5" />} loading={actions.plan.isPending} onClick={() => actions.plan.mutate()} title="Architect designs the system, then the Project Manager breaks it into tasks">
              Plan
            </Button>
            {run.running ? (
              <>
                <Button
                  variant="default"
                  icon={run.paused ? <Play className="size-3.5" /> : <RotateCcw className="size-3.5" />}
                  loading={actions.pause.isPending || actions.resume.isPending}
                  onClick={() => (run.paused ? actions.resume.mutate() : actions.pause.mutate())}
                >
                  {run.paused ? 'Resume' : 'Pause'}
                </Button>
                <Button variant="danger" icon={<Square className="size-3.5" />} onClick={() => setConfirmStop(true)}>
                  Stop
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={<Play className="size-3.5" />} loading={actions.run.isPending} disabled={tasks === 0} onClick={() => actions.run.mutate({ plan: tasks === 0 })}>
                Run
              </Button>
            )}
          </>
        }
      />

      {actions.stop.error || actions.run.error ? (
        <div className="mb-3">
          <ErrorState title="The last action failed" detail={((actions.stop.error ?? actions.run.error) as Error).message} />
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-line pb-2">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to ? `/projects/${projectId}/${tab.to}` : `/projects/${projectId}`}
            end={!tab.to}
            className={({ isActive }) =>
              cx('rounded-[var(--radius-sm)] px-2 py-1 text-[12px]', isActive ? 'bg-accent-soft/60 text-ink' : 'text-muted hover:bg-hover hover:text-ink')
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>

      <Routes>
        <Route index element={<Overview />} />
        <Route path="tasks" element={<TasksTab />} />
        <Route path="graph" element={<GraphTab />} />
        <Route path="files" element={<FilesTab />} />
        <Route path="git" element={<GitTab />} />
        <Route path="tests" element={<TestsTab />} />
        <Route path="agents" element={<AgentsTab />} />
        <Route path="memory" element={<MemoryTab />} />
        <Route path="activity" element={<ActivityTab />} />
      </Routes>

      <Modal
        open={confirmStop}
        title="Stop this run?"
        onClose={() => setConfirmStop(false)}
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                actions.stop.mutate();
                setConfirmStop(false);
              }}
            >
              Stop run
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-muted">
          Running agents are asked to stop; tasks in flight return to the queue as <Mono>ready</Mono> and nothing is restarted until you press Run again. Work already committed stays in the repository.
        </p>
      </Modal>
    </div>
  );
}

function Overview(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const project = useProject(projectId);
  const tasks = useProjectTasks(projectId);
  const supervision = useSupervision(projectId);
  const platform = usePlatform();
  const [openModal, setOpenModal] = useState<'terminal' | 'reveal' | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const data = project.data;
  if (!data) return <LoadingRows rows={5} />;

  const counts = data.counts as Record<string, number>;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const taskList = tasks.data ?? [];
  const storyPoints = taskList.reduce((sum, task) => sum + (task.estimatedOutputTokens ?? 0), 0);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section title="Progress" className="lg:col-span-2">
        <div className="space-y-2 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="text-muted">
              {counts.done ?? 0} of {total} tasks done
              {counts.failed ? <span className="ml-2 text-danger">{counts.failed} failed</span> : null}
              {counts.blocked ? <span className="ml-2 text-warn">{counts.blocked} blocked</span> : null}
            </span>
            <span className="text-faint tabular">
              {data.run.ticks} scheduler ticks · last {formatRelativeTime(data.run.lastTickAt ?? null)}
            </span>
          </div>
          <ProgressBar value={total ? (counts.done ?? 0) / total : 0} tone="free" label="Tasks completed" />
          <div className="grid grid-cols-2 gap-3 pt-1 md:grid-cols-4">
            <Stat label="Running" value={counts.running ?? 0} />
            <Stat label="Ready" value={counts.ready ?? 0} />
            <Stat label="Blocked" value={counts.blocked ?? 0} tone={counts.blocked ? 'warning' : 'muted'} />
            <Stat label="Estimated output" value={formatTokens(storyPoints)} hint="sum of planned output tokens" />
          </div>
          {data.run.lastError ? (
            <div className="rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-2 py-1.5 text-[12px] text-danger">Last run error: {data.run.lastError}</div>
          ) : null}
          {data.run.lastResult?.notes?.length ? (
            <ul className="space-y-0.5 text-[11px] text-muted">
              {data.run.lastResult.notes.slice(0, 6).map((note: string, index: number) => (
                <li key={index}>· {note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Section>

      <Section title="Project">
        <div className="px-3 py-2.5">
          <KeyValue
            columns={1}
            items={[
              { label: 'Branch', value: <Mono>{data.project.branch}</Mono> },
              { label: 'Workspace', value: <Mono className="break-all">{data.project.workspacePath}</Mono> },
              { label: 'Created', value: formatDateTime(data.project.createdAt) },
              { label: 'Source repository', value: data.project.sourceRepo ?? <span className="text-faint">none (new repository)</span> },
              { label: 'Execution mode', value: data.project.settings?.executionMode ?? 'inherited' },
              { label: 'Max parallel agents', value: String(data.project.settings?.maxParallelAgents ?? '—') },
              { label: 'Pending approvals', value: data.pendingApprovals ? <span className="text-warn">{data.pendingApprovals}</span> : '0' },
            ]}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              icon={<FolderOpen className="size-3.5" />}
              onClick={async () => {
                try {
                  const result = await api.reveal(data.project.id);
                  setActionResult(result.revealed ? `Revealed ${result.path}` : 'The file manager could not open that path.');
                } catch (err) {
                  setActionResult(err instanceof Error ? err.message : String(err));
                }
                setOpenModal('reveal');
              }}
            >
              Reveal workspace
            </Button>
            <Button
              icon={<Terminal className="size-3.5" />}
              onClick={async () => {
                try {
                  const result = await api.openTerminal(data.project.id);
                  setActionResult(result.opened ? 'Terminal opened at the project root.' : (result.reason ?? 'No terminal emulator available.'));
                } catch (err) {
                  setActionResult(err instanceof Error ? err.message : String(err));
                }
                setOpenModal('terminal');
              }}
            >
              Open terminal
            </Button>
            {platform.data?.updates ? (
              <Button
                variant="ghost"
                icon={<ExternalLink className="size-3.5" />}
                onClick={async () => {
                  const health = await api.health().catch(() => null);
                  if (health) setActionResult(`API ${health.version} · shell ${health.shell.kind} · database ${formatBytes(health.database.bytes)}`);
                }}
              >
                Runtime info
              </Button>
            ) : null}
          </div>
          {actionResult ? <div className="mt-2 text-[11px] text-faint">{actionResult}</div> : null}
        </div>
      </Section>

      <Section title="Supervisor" className="lg:col-span-2">
        {supervision.data ? (
          <div className="px-3 py-2.5 text-[12px]">
            <div className="flex flex-wrap gap-3 text-muted">
              <span>Inspected {supervision.data.stats?.tasksInspected ?? '—'} tasks</span>
              <span>Stuck {supervision.data.stats?.stuck ?? 0}</span>
              <span>Retries {supervision.data.stats?.retries ?? 0}</span>
              <span className="text-faint">last check {formatRelativeTime(supervision.data.inspectedAt)}</span>
            </div>
            {supervision.data.issues.length ? (
              <ul className="mt-2 space-y-1">
                {supervision.data.issues.map((issue, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <AlertTriangle className={cx('mt-0.5 size-3.5 shrink-0', issue.severity === 'error' ? 'text-danger' : 'text-warn')} />
                    <span className="text-muted">
                      <span className="text-ink">{issue.kind.replace(/_/g, ' ')}</span> — {issue.detail}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-muted">No stuck tasks, no failing agents, no repeated loops detected. Hard limits are enforced per task: retries, tokens, runtime and iterations.</p>
            )}
            {supervision.data.interventions?.length ? (
              <div className="mt-2 border-t border-line pt-2">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Interventions</div>
                <ul className="space-y-0.5 text-[11px] text-muted">
                  {supervision.data.interventions.slice(0, 8).map((entry, index) => (
                    <li key={index}>
                      · {entry.kind.replace(/_/g, ' ')}: {entry.detail} <TimeAgo iso={entry.at} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <LoadingRows rows={3} />
        )}
      </Section>

      <Section title="Agent states">
        <div className="divide-y divide-line/40">
          {(data.agents ?? []).map((agent) => (
            <div key={agent.agentId} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <AgentLink agentId={agent.agentId} />
              <AgentStateBadge state={agent.state} />
            </div>
          ))}
          {(data.agents ?? []).length === 0 ? <div className="px-3 py-3 text-[12px] text-muted">No agent has run on this project yet.</div> : null}
        </div>
      </Section>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'warning' | 'muted' }): ReactNode {
  const colour = tone === 'warning' ? 'text-warn' : tone === 'muted' ? 'text-muted' : 'text-ink';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cx('tabular text-[15px]', colour)}>{value}</div>
      {hint ? <div className="text-[10px] text-faint">{hint}</div> : null}
    </div>
  );
}

function TasksTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  return <TaskBoard projectId={projectId as string} />;
}

function GraphTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const graph = useProjectGraph(projectId);
  if (graph.isLoading) return <LoadingRows rows={6} />;
  if (graph.error) return <ErrorState title="The dependency graph could not be loaded" detail={(graph.error as Error).message} retry={() => void graph.refetch()} />;
  return <DependencyGraph graph={graph.data!} />;
}

function FilesTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const [path, setPath] = useState('.');
  const files = useProjectFiles(projectId, path);
  const [selected, setSelected] = useState<string | null>(null);
  const content = useProjectFile(projectId, selected);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section
        title={
          <span className="flex items-center gap-2">
            Files <Mono>{path}</Mono>
            {path !== '.' ? (
              <button type="button" className="text-accent hover:underline" onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '.')}>
                up
              </button>
            ) : null}
          </span>
        }
        className="lg:col-span-1"
      >
        {files.isLoading ? <LoadingRows rows={6} /> : null}
        {files.error ? <ErrorState title="Could not list the workspace" detail={(files.error as Error).message} retry={() => void files.refetch()} /> : null}
        <ul className="divide-y divide-line/40">
          {(files.data?.entries ?? []).map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => (entry.type === 'directory' ? setPath(entry.path) : setSelected(entry.path))}
                className={cx('flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-[12px] hover:bg-hover', selected === entry.path && 'bg-hover')}
              >
                <span className="min-w-0 truncate">{entry.type === 'directory' ? `${entry.name}/` : entry.name}</span>
                <span className="shrink-0 tabular text-[10px] text-faint">{entry.size !== undefined ? formatBytes(entry.size) : ''}</span>
              </button>
            </li>
          ))}
          {files.data && files.data.entries.length === 0 ? <li className="px-3 py-3 text-[12px] text-muted">This directory is empty.</li> : null}
        </ul>
      </Section>
      <Section title={selected ?? 'Select a file'} className="lg:col-span-2">
        {!selected ? <div className="px-3 py-6 text-center text-[12px] text-muted">Choose a file to read it. Content is treated as untrusted data by the agents.</div> : null}
        {content.isLoading ? <LoadingRows rows={8} /> : null}
        {content.error ? <ErrorState title="Could not read the file" detail={(content.error as Error).message} /> : null}
        {content.data ? (
          <pre className="max-h-[65vh] overflow-auto px-3 py-2 text-[11px] leading-4 text-ink">{content.data.content}</pre>
        ) : null}
      </Section>
    </div>
  );
}

function GitTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const status = useGitStatus(projectId);
  const log = useGitLog(projectId);
  const [diff, setDiff] = useState<{ from?: string; to?: string } | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);

  const loadDiff = async (query: { from?: string; to?: string }): Promise<void> => {
    setLoadingDiff(true);
    try {
      const result = await api.gitDiff(projectId as string, query);
      setDiffText(result.diff || 'No differences.');
      setDiff(query);
    } catch (err) {
      setDiffText(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDiff(false);
    }
  };

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section title="Working tree" className="lg:col-span-1">
        {status.isLoading ? <LoadingRows rows={4} /> : null}
        {status.data ? (
          <div className="px-3 py-2 text-[12px]">
            <div className="mb-1 flex items-center gap-2">
              <GitBranch className="size-3.5 text-faint" />
              <Mono>{status.data.branch}</Mono>
              {status.data.clean ? <Badge tone="free">clean</Badge> : <Badge tone="warn">{status.data.entries.length} changed</Badge>}
              {status.data.operationInProgress ? <Badge tone="danger">{status.data.operationInProgress}</Badge> : null}
            </div>
            <ul className="space-y-0.5">
              {status.data.entries.map((change) => (
                <li key={change.path} className="flex items-center justify-between gap-2">
                  <button type="button" className="truncate text-left text-accent hover:underline" onClick={() => void loadDiff({ path: change.path } as never)}>
                    {change.path}
                  </button>
                  <Mono>{change.code.trim()}</Mono>
                </li>
              ))}
              {status.data.entries.length === 0 ? <li className="text-muted">Nothing uncommitted.</li> : null}
            </ul>
            <div className="mt-2 border-t border-line pt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Branches</div>
              <ul className="space-y-0.5">
                {status.data.branches.map((branch) => (
                  <li key={branch.name} className="flex items-center justify-between gap-2">
                    <Mono className={branch.current ? 'text-ink' : undefined}>{branch.name}</Mono>
                    {branch.current ? <Badge tone="accent">current</Badge> : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
      </Section>

      <Section
        title="Commits"
        className="lg:col-span-2"
        actions={
          <Button variant="ghost" onClick={() => void loadDiff({})} loading={loadingDiff}>
            diff HEAD
          </Button>
        }
      >
        {log.isLoading ? <LoadingRows rows={6} /> : null}
        {log.data ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Sha</th>
                <th>Message</th>
                <th>Author</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {log.data.commits.map((commit) => (
                <tr key={commit.sha} className="row-hover">
                  <td>
                    <Mono>{commit.sha.slice(0, 8)}</Mono>
                  </td>
                  <td className="max-w-[420px] truncate">{commit.message}</td>
                  <td title={commit.authorEmail}>{commit.authorName}</td>
                  <td>
                    <TimeAgo iso={commit.committedAt} />
                  </td>
                </tr>
              ))}
              {log.data.commits.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-muted">
                    No commits yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
        {diff ? (
          <div className="border-t border-line">
            <div className="flex items-center justify-between px-3 py-1 text-[11px] text-faint">
              <span>diff {diff.from ?? 'HEAD'}{diff.to ? `..${diff.to}` : ''}</span>
              <button type="button" className="hover:text-ink" onClick={() => setDiff(null)}>
                close
              </button>
            </div>
            <pre className="max-h-[45vh] overflow-auto px-3 py-2 text-[11px] leading-4">{diffText}</pre>
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function TestsTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const tests = useTests(projectId);
  const actions = useProjectActions(projectId);

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Section
        title="Summary"
        actions={
          <Button loading={actions.runTests.isPending} onClick={() => actions.runTests.mutate(undefined)}>
            Run tests
          </Button>
        }
      >
        {tests.data ? (
          <div className="space-y-2 px-3 py-2 text-[12px]">
            <KeyValue
              columns={1}
              items={[
                { label: 'Runs recorded', value: tests.data.summary.runs },
                { label: 'Passing runs', value: tests.data.summary.passed },
                { label: 'Failing runs', value: tests.data.summary.failed },
                {
                  label: 'Last status',
                  value: tests.data.summary.lastStatus ? <Badge tone={tests.data.summary.lastStatus === 'passed' ? 'free' : 'danger'}>{tests.data.summary.lastStatus}</Badge> : <span className="text-faint">never run</span>,
                },
              ]}
            />
            {tests.data.runs.length === 0 ? (
              <p className="text-[11px] text-faint">
                No test run has been recorded. The QA agent runs the project's test command when it can, and you can trigger it manually — results are stored either way.
              </p>
            ) : null}
          </div>
        ) : (
          <LoadingRows rows={4} />
        )}
      </Section>
      <Section title="Runs" className="lg:col-span-2">
        {tests.data ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Command</th>
                <th>Passed</th>
                <th>Failed</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {tests.data.runs.map((run) => (
                <tr key={run.id} className="row-hover">
                  <td>
                    <Badge tone={run.status === 'passed' ? 'free' : run.status === 'failed' ? 'danger' : 'neutral'}>{run.status}</Badge>
                  </td>
                  <td className="max-w-[320px] truncate">
                    <Mono>{run.command ?? '—'}</Mono>
                  </td>
                  <td className="tabular">{run.passed ?? '—'}</td>
                  <td className="tabular">{run.failed ?? '—'}</td>
                  <td className="tabular">{run.durationMs !== undefined ? formatDuration(run.durationMs) : '—'}</td>
                  <td>
                    <TimeAgo iso={run.startedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <LoadingRows rows={4} />
        )}
      </Section>
    </div>
  );
}

function AgentsTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const tasks = useProjectTasks(projectId);
  const grouped = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks.data ?? []) {
      const list = map.get(task.agentRole) ?? [];
      list.push(task);
      map.set(task.agentRole, list);
    }
    return [...map.entries()];
  }, [tasks.data]);

  if (tasks.isLoading) return <LoadingRows rows={6} />;
  if (grouped.length === 0) return <Panel className="p-6 text-center text-[12px] text-muted">No agent has been assigned work on this project yet.</Panel>;

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {grouped.map(([agentId, list]) => {
        const done = list.filter((task) => task.status === 'done').length;
        return (
          <Section key={agentId} title={<AgentLink agentId={agentId} />} actions={<Mono>{done}/{list.length}</Mono>}>
            <ul className="divide-y divide-line/40">
              {list.map((task) => (
                <li key={task.id} className="flex items-start justify-between gap-2 px-3 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] text-ink" title={task.title}>
                      {task.title}
                    </div>
                    <div className="text-[10px] text-faint">
                      {task.taskType.replace(/_/g, ' ')} · attempt {task.attempts}/{task.maxAttempts}
                      {task.lastModelId ? ` · ${task.lastModelId}` : ''}
                    </div>
                  </div>
                  <TaskStatusBadge status={task.status} />
                </li>
              ))}
            </ul>
          </Section>
        );
      })}
    </div>
  );
}

function MemoryTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const memory = useMemory(projectId);
  const messages = useMessages(projectId);

  if (memory.isLoading) return <LoadingRows rows={6} />;
  if (memory.error) return <ErrorState title="Memory could not be loaded" detail={(memory.error as Error).message} retry={() => void memory.refetch()} />;
  const data = memory.data!;
  const entries = data.entries ?? [];

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <Section title="Shared project memory" actions={<Mono>{entries.length} entries</Mono>}>
          {entries.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-muted">Memory fills in as agents record decisions, code state and test state.</div>
          ) : (
            <ul className="divide-y divide-line/40">
              {entries.map((entry) => (
                <li key={entry.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-medium text-ink">{entry.title}</span>
                    <Badge tone="neutral">{entry.kind.replace(/_/g, ' ')}</Badge>
                    {entry.supersededBy ? <Badge tone="unknown">superseded</Badge> : null}
                    <span className="text-[10px] text-faint">
                      {entry.trust} · importance {formatNumber(entry.importance, { digits: 2 })} · <TimeAgo iso={entry.updatedAt} />
                    </span>
                  </div>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-4 text-muted">{entry.body.slice(0, 1_200)}</pre>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <Section title="Agent messages" actions={<Mono>{(messages.data ?? []).length}</Mono>}>
        <ul className="divide-y divide-line/40">
          {(messages.data ?? []).slice(0, 40).map((message) => (
            <li key={message.id} className="px-3 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {message.agentId ? <AgentLink agentId={message.agentId} /> : <span className="text-muted">system</span>}
                <Badge tone={message.role === 'assistant' ? 'neutral' : message.role === 'user' ? 'accent' : 'unknown'}>{message.role}</Badge>
                {message.trust !== 'trusted' ? <Badge tone="warn">{message.trust}</Badge> : null}
                {message.taskId ? (
                  <Link to={`/projects/${message.projectId}/tasks`} className="text-[10px] text-faint hover:text-accent">
                    task {message.taskId.slice(0, 8)}
                  </Link>
                ) : null}
                <TimeAgo iso={message.createdAt} />
              </div>
              <div className="mt-0.5 line-clamp-3 text-[11px] text-muted">{message.content.slice(0, 300)}</div>
            </li>
          ))}
          {(messages.data ?? []).length === 0 ? <li className="px-3 py-4 text-[12px] text-muted">Agents have not messaged each other yet.</li> : null}
        </ul>
      </Section>
    </div>
  );
}

function ActivityTab(): ReactNode {
  const { projectId } = useParams<{ projectId: string }>();
  const [tab, setTab] = useState<'executions' | 'traces'>('executions');
  const executions = useExecutions(projectId);
  const traces = useTraces({ projectId, limit: 100 });

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <button type="button" className={cx(tab === 'executions' ? 'text-ink' : 'text-muted')} onClick={() => setTab('executions')}>
            Executions
          </button>
          <span className="text-faint">/</span>
          <button type="button" className={cx(tab === 'traces' ? 'text-ink' : 'text-muted')} onClick={() => setTab('traces')}>
            Model calls
          </button>
        </span>
      }
    >
      {tab === 'executions' ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Iterations</th>
              <th>Tool calls</th>
              <th>Tokens</th>
              <th>Started</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {(executions.data ?? []).map((execution) => (
              <tr key={execution.id} className="row-hover">
                <td>
                  <AgentLink agentId={execution.agentId} />
                </td>
                <td>
                  <Badge tone={execution.status === 'succeeded' || execution.status === 'done' ? 'free' : execution.status === 'failed' ? 'danger' : 'accent'}>{execution.status}</Badge>
                </td>
                <td className="tabular">{execution.iterations}</td>
                <td className="tabular">{execution.toolCalls}</td>
                <td className="tabular">
                  {formatTokens((execution.tokensIn ?? 0) + (execution.tokensOut ?? 0))}
                </td>
                <td>
                  <TimeAgo iso={execution.startedAt} />
                </td>
                <td className="tabular">{execution.finishedAt ? formatDuration(new Date(execution.finishedAt).getTime() - new Date(execution.startedAt).getTime()) : 'running'}</td>
              </tr>
            ))}
            {(executions.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-muted">
                  No executions recorded for this project yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Agent</th>
              <th>Model</th>
              <th>Task type</th>
              <th>Latency</th>
              <th>Tokens</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(traces.data ?? []).map((trace) => (
              <tr key={trace.traceId} className="row-hover">
                <td>
                  <TimeAgo iso={trace.startedAt} />
                </td>
                <td>{trace.agentId ? <AgentLink agentId={trace.agentId} /> : '—'}</td>
                <td className="max-w-[260px] truncate">
                  <Mono>{trace.modelId}</Mono>
                </td>
                <td>{trace.taskType?.replace(/_/g, ' ') ?? '—'}</td>
                <td className="tabular">{formatNumber(trace.latencyMs)} ms</td>
                <td className="tabular">{formatTokens(trace.usage?.totalTokens ?? null)}</td>
                <td>
                  <Badge tone={trace.status === 'success' ? 'free' : 'danger'}>{trace.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

