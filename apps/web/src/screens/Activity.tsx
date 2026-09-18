import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, cx, ErrorState, Input, LoadingRows, Panel, Select, StatusDot } from '@aido/ui';
import type { OrchestratorEvent } from '@aido/types';
import { useActivity } from '../lib/api.js';
import { PageHeader, TimeAgo } from '../components/common.js';

/**
 * Activity (§39): the event stream, with the agent-transcript view.
 *
 * This is where "what did the team actually do" is answered: every event the
 * orchestrator emitted, filterable by severity, agent and type, plus the model calls
 * with their routing explanation. Agent *reasoning* is deliberately not shown — only
 * actions, tool outcomes and conclusions, which is what the event payloads contain.
 */
export function ActivityScreen(): ReactNode {
  const [filters, setFilters] = useState<{ type?: string; severity?: string; agentId?: string; limit: number }>({ limit: 200 });
  const activity = useActivity(filters);
  const [selected, setSelected] = useState<OrchestratorEvent | null>(null);

  const events = activity.data?.events ?? [];
  const counts = activity.data?.counts ?? [];
  const types = useMemo(() => [...new Set(events.map((event) => event.type))].sort(), [events]);
  const agents = useMemo(() => [...new Set(events.map((event) => event.agentId).filter(Boolean))].sort(), [events]);

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Activity" subtitle={`${events.length} event${events.length === 1 ? '' : 's'} shown · newest first`} />

      <div className="mb-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Severity</span>
          <Select value={filters.severity ?? ''} onChange={(event) => setFilters({ ...filters, severity: event.target.value || undefined })}>
            <option value="">all</option>
            <option value="info">info</option>
            <option value="warning">warning</option>
            <option value="error">error</option>
          </Select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Agent</span>
          <Select value={filters.agentId ?? ''} onChange={(event) => setFilters({ ...filters, agentId: event.target.value || undefined })}>
            <option value="">all</option>
            {agents.map((agentId) => (
              <option key={agentId} value={agentId as string}>
                {agentId}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Event type</span>
          <Input
            list="event-types"
            placeholder="e.g. task.completed"
            value={filters.type ?? ''}
            onChange={(event) => setFilters({ ...filters, type: event.target.value || undefined })}
            className="w-52"
          />
          <datalist id="event-types">
            {types.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Limit</span>
          <Select value={String(filters.limit)} onChange={(event) => setFilters({ ...filters, limit: Number(event.target.value) })}>
            {[100, 200, 500, 1000].map((limit) => (
              <option key={limit} value={limit}>
                {limit}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex-1" />
        <Button variant="ghost" onClick={() => void activity.refetch()} loading={activity.isFetching}>
          Refresh
        </Button>
      </div>

      {counts.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {counts.slice(0, 12).map((entry, index) => (
            <Badge key={index} tone="neutral" title={JSON.stringify(entry)}>
              {String(entry.period ?? entry.type ?? `row ${index}`)}: {String(entry.count ?? entry.events ?? '')}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          {activity.isLoading ? <LoadingRows rows={10} /> : null}
          {activity.error ? <ErrorState title="Activity could not be loaded" detail={(activity.error as Error).message} retry={() => void activity.refetch()} /> : null}
          <ul className="divide-y divide-line/40">
            {events.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  onClick={() => setSelected(event)}
                  className={cx('flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-hover', selected?.id === event.id && 'bg-hover')}
                >
                  <StatusDot tone={event.severity === 'error' ? 'danger' : event.severity === 'warning' ? 'warn' : 'unknown'} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="tabular text-faint">{event.type}</span>
                      {event.agentId ? (
                        <Link to={`/agents/${event.agentId}`} className="text-accent hover:underline" onClick={(clickEvent) => clickEvent.stopPropagation()}>
                          {event.agentId}
                        </Link>
                      ) : null}
                      {event.taskId ? <span className="tabular text-[10px] text-faint">task {event.taskId.slice(0, 8)}</span> : null}
                      {event.traceId ? <span className="tabular text-[10px] text-faint">trace {event.traceId.slice(0, 8)}</span> : null}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-ink">{event.message}</span>
                  </span>
                  <TimeAgo iso={event.at} />
                </button>
              </li>
            ))}
            {events.length === 0 && !activity.isLoading ? <li className="px-3 py-6 text-center text-[12px] text-muted">No events match these filters.</li> : null}
          </ul>
        </Panel>

        <Panel>
          <div className="panel-header">{selected ? 'Event payload' : 'Select an event'}</div>
          {selected ? (
            <div className="space-y-2 px-3 py-2 text-[11px]">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-faint">Type</div>
                <div className="tabular">{selected.type}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-faint">Recorded</div>
                <div>{new Date(selected.at).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-faint">Context</div>
                <ul className="space-y-0.5 text-muted">
                  <li>project: {selected.projectId ?? '—'}</li>
                  <li>task: {selected.taskId ?? '—'}</li>
                  <li>agent: {selected.agentId ?? '—'}</li>
                  <li>trace: {selected.traceId ?? '—'}</li>
                  <li>severity: {selected.severity}</li>
                </ul>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-faint">Payload</div>
                <pre className="max-h-80 scroll-y whitespace-pre-wrap rounded bg-inset px-2 py-1.5 text-[10px] leading-4 text-muted">
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              </div>
              {selected.projectId ? (
                <Link to={`/projects/${selected.projectId}/activity`} className="inline-block text-accent hover:underline">
                  open project activity →
                </Link>
              ) : null}
            </div>
          ) : (
            <div className="px-3 py-3 text-[12px] text-muted">
              Every event carries the project, task, agent and trace it belongs to, so a decision can be traced from the UI back to the model call that produced it.
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
