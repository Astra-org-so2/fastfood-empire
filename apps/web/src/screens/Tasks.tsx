import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileCode2, RefreshCw } from 'lucide-react';
import { Badge, Button, cx, ErrorState, formatDateTime, formatTokens, LoadingRows, Panel, StatusDot } from '@aido/ui';
import type { Task, TaskStatus } from '@aido/types';
import { useProject, useProjectTasks } from '../lib/api.js';
import { AgentLink, Mono, Section, TaskStatusBadge, TimeAgo } from '../components/common.js';

/**
 * The task board: a kanban over the same DAG the scheduler uses (§16, §39).
 *
 * Columns are the real task states, so a card moving between columns is the scheduler
 * changing state — not a UI-only idea of progress. Blocked cards name the dependency
 * that is holding them, which is the question an operator always has.
 */

const COLUMNS: { id: TaskStatus; label: string; hint: string }[] = [
  { id: 'blocked', label: 'Blocked', hint: 'waiting on a dependency' },
  { id: 'ready', label: 'Ready', hint: 'eligible to be dispatched' },
  { id: 'running', label: 'Running', hint: 'an agent is working' },
  { id: 'in_review', label: 'In review', hint: 'review or QA is looking at it' },
  { id: 'done', label: 'Done', hint: 'finished and recorded' },
  { id: 'failed', label: 'Failed', hint: 'error or limit reached' },
];

export function TaskBoard({ projectId }: { projectId: string }): ReactNode {
  const project = useProject(projectId);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const tasks = useProjectTasks(projectId);
  const taskList = tasks.data ?? [];

  const byStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    const term = filter.trim().toLowerCase();
    for (const task of taskList) {
      if (term && !`${task.title} ${task.agentRole} ${task.taskType}`.toLowerCase().includes(term)) continue;
      const status = task.status;
      const list = map.get(status) ?? [];
      list.push(task);
      map.set(status, list);
    }
    return map;
  }, [taskList, filter]);

  const titleById = useMemo(() => new Map(taskList.map((task) => [task.id, task.title])), [taskList]);
  const statusById = useMemo(() => new Map(taskList.map((task) => [task.id, task.status])), [taskList]);

  if (tasks.isLoading) return <LoadingRows rows={6} />;
  if (tasks.error) return <ErrorState title="Tasks could not be loaded" detail={(tasks.error as Error).message} retry={() => void tasks.refetch()} />;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="filter tasks…"
            className="h-7 w-56 rounded-[var(--radius-sm)] border border-line bg-inset px-2 text-[12px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
            aria-label="Filter tasks"
          />
          <span className="text-[11px] text-faint">
            {taskList.length} task{taskList.length === 1 ? '' : 's'} · {project.data?.counts?.done ?? 0} done
          </span>
        </div>
        <Button variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void tasks.refetch()}>
          Refresh
        </Button>
      </div>

      {taskList.length === 0 ? (
        <Panel className="p-6 text-center">
          <div className="text-[13px] font-medium">No tasks yet</div>
          <p className="mt-1 text-[12px] text-muted">Press Plan on the project to have the Architect design the system and the Project Manager break it into tasks.</p>
        </Panel>
      ) : (
        <div className="grid gap-2 xl:grid-cols-5">
          {COLUMNS.map((column) => {
            const items = byStatus.get(column.id) ?? [];
            return (
              <div key={column.id} className="panel flex min-h-[160px] flex-col">
                <div className="panel-header">
                  <span className="flex items-center gap-1.5">
                    {column.id === 'running' ? <StatusDot tone="accent" pulse /> : null}
                    {column.label}
                  </span>
                  <span className="tabular text-faint">{items.length}</span>
                </div>
                <div className="scroll-y max-h-[62vh] space-y-1.5 p-1.5">
                  {items.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      titleById={titleById}
                      statusById={statusById}
                      expanded={expanded === task.id}
                      onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
                    />
                  ))}
                  {items.length === 0 ? <div className="px-2 py-3 text-[11px] text-faint">{column.hint}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  titleById,
  statusById,
  expanded,
  onToggle,
}: {
  task: Task;
  titleById: Map<string, string>;
  statusById: Map<string, TaskStatus>;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const blockers = task.dependsOn.filter((id) => statusById.get(id) !== 'done');
  const result = task.result;

  return (
    <div className={cx('panel bg-surface-2', expanded && 'ring-1 ring-accent/40')}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left" aria-expanded={expanded}>
        {expanded ? <ChevronDown className="mt-0.5 size-3 shrink-0 text-faint" /> : <ChevronRight className="mt-0.5 size-3 shrink-0 text-faint" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] leading-4 text-ink">{task.title}</span>
          <span className="mt-0.5 block truncate text-[10px] text-faint">
            <AgentLink agentId={task.agentRole} /> · {task.taskType.replace(/_/g, ' ')} · #{task.orderIndex + 1}
          </span>
        </span>
      </button>

      <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
        <Badge tone="neutral">{task.taskType.replace(/_/g, ' ')}</Badge>
        {task.attempts > 0 ? <Badge tone={task.attempts >= task.maxAttempts ? 'danger' : 'neutral'}>{task.attempts}/{task.maxAttempts} attempts</Badge> : null}
        {blockers.length ? (
          <Badge tone="warn" title={blockers.map((id) => titleById.get(id) ?? id).join('\n')}>
            {blockers.length} blocking
          </Badge>
        ) : null}
        {(task.estimatedOutputTokens ?? 0) > 0 ? <Badge tone="neutral">~{formatTokens(task.estimatedOutputTokens)} out</Badge> : null}
      </div>

      {expanded ? (
        <div className="border-t border-line px-2 py-1.5 text-[11px]">
          <div className="text-muted">{task.description}</div>
          {task.resourceLocks.length ? (
            <div className="mt-1">
              <div className="text-[10px] uppercase tracking-wide text-faint">Resource locks</div>
              <div className="flex flex-wrap gap-1">
                {task.resourceLocks.map((lock) => (
                  <Mono key={lock}>{lock}</Mono>
                ))}
              </div>
            </div>
          ) : null}
          {task.dependsOn.length ? (
            <div className="mt-1">
              <div className="text-[10px] uppercase tracking-wide text-faint">Depends on</div>
              <ul className="space-y-0.5">
                {task.dependsOn.map((id) => (
                  <li key={id} className={statusById.get(id) === 'done' ? 'text-muted' : 'text-warn'}>
                    {statusById.get(id) === 'done' ? '✓' : '○'} {titleById.get(id) ?? id}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {task.lastModelId ? (
            <div className="mt-1">
              <span className="text-[10px] uppercase tracking-wide text-faint">Last model </span>
              <Mono>{task.lastModelId}</Mono>
            </div>
          ) : null}
          {task.lastError ? <div className="mt-1 rounded bg-danger/10 px-1.5 py-1 text-danger">{task.lastError}</div> : null}
          {result ? (
            <div className="mt-1.5 border-t border-line pt-1.5">
              <div className="text-[10px] uppercase tracking-wide text-faint">Result</div>
              <div className="text-muted">{result.summary}</div>
              {result.artifacts?.length ? (
                <ul className="mt-0.5 space-y-0.5">
                  {result.artifacts.map((artefact) => (
                    <li key={artefact.path} className="flex items-center gap-1">
                      <FileCode2 className="size-3 text-faint" />
                      <Mono>{artefact.path}</Mono>
                      <Badge tone={artefact.action === 'created' ? 'free' : artefact.action === 'deleted' ? 'danger' : 'neutral'}>{artefact.action}</Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.findings?.length ? (
                <ul className="mt-1 space-y-0.5">
                  {result.findings.slice(0, 5).map((finding, index) => (
                    <li key={index} className={finding.severity === 'high' || finding.severity === 'critical' ? 'text-danger' : 'text-muted'}>
                      [{finding.severity}] {finding.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              {result.approvalRequest ? (
                <div className="mt-1 text-warn">Approval requested: {result.approvalRequest.action}</div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-faint">
            <TimeAgo iso={task.updatedAt} />
            <span>{task.completedAt ? formatDateTime(task.completedAt) : task.startedAt ? `started ${formatDateTime(task.startedAt)}` : 'not started'}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Re-exported for screens that need the same table; kept tiny on purpose. */
export function TaskTable({ tasks }: { tasks: Task[] }): ReactNode {
  return (
    <Section title="Tasks">
      <table className="data-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="row-hover">
              <td className="max-w-[420px] truncate">{task.title}</td>
              <td>
                <AgentLink agentId={task.agentRole} />
              </td>
              <td>
                <TaskStatusBadge status={task.status} />
              </td>
              <td className="tabular">
                {task.attempts}/{task.maxAttempts}
              </td>
              <td>
                <TimeAgo iso={task.updatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

