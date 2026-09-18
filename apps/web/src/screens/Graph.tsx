import { useMemo, useState, type ReactNode } from 'react';
import { Badge, cx, EmptyState, Panel, StatusDot } from '@aido/ui';

import type { AgentId } from '@aido/types';
import type { TaskGraphResponse } from '@aido/ui';
import { AgentLink, Mono } from '../components/common.js';

/**
 * The dependency graph (§16, §39).
 *
 * Rendered as a layered layout: each node sits in the column of its longest dependency
 * chain, so "what can run now" and "what is holding this back" are readable at a glance.
 * Positions are computed from the DAG itself, so the picture cannot drift from the
 * scheduler's view — if an edge exists here, the scheduler honours it.
 *
 * Cycles are reported explicitly: a cyclic plan is a bug the operator must see, not a
 * layout that silently loops.
 */

const COLUMN_WIDTH = 190;
const ROW_HEIGHT = 46;

const STATUS_TONE: Record<string, 'free' | 'accent' | 'danger' | 'unknown' | 'warn' | 'neutral'> = {
  done: 'free',
  running: 'accent',
  in_progress: 'accent',
  ready: 'accent',
  blocked: 'unknown',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
  queued: 'neutral',
};

export function DependencyGraph({ graph }: { graph: TaskGraphResponse }): ReactNode {
  const [selected, setSelected] = useState<string | null>(null);

  const layout = useMemo(() => {
    const nodes = [...graph.nodes];
    const byDepth = new Map<number, typeof nodes>();
    for (const node of nodes) {
      const list = byDepth.get(node.depth) ?? [];
      list.push(node);
      byDepth.set(node.depth, list);
    }
    const positions = new Map<string, { x: number; y: number }>();
    let maxRow = 0;
    for (const [depth, list] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a.title.localeCompare(b.title));
      list.forEach((node, index) => {
        positions.set(node.id, { x: depth * COLUMN_WIDTH + 12, y: index * ROW_HEIGHT + 12 });
      });
      maxRow = Math.max(maxRow, list.length);
    }
    return { positions, width: (byDepth.size || 1) * COLUMN_WIDTH + 24, height: maxRow * ROW_HEIGHT + 60, depths: [...byDepth.keys()].sort((a, b) => a - b) };
  }, [graph.nodes]);

  if (graph.nodes.length === 0) {
    return <EmptyState title="No tasks to graph" detail="The dependency graph appears once the project has a plan." />;
  }

  const selectedNode = graph.nodes.find((node) => node.id === selected) ?? null;

  return (
    <div className="grid gap-3 lg:grid-cols-4">
      <Panel className="lg:col-span-3">
        <div className="panel-header">
          <span>
            Dependency graph — {graph.nodes.length} tasks, {graph.edges.length} edges
          </span>
          <span className="normal-case tracking-normal text-faint">columns are dependency depth; left runs first</span>
        </div>
        {graph.cycles.length ? (
          <div className="border-b border-danger/40 bg-danger/5 px-3 py-1.5 text-[11px] text-danger">
            {graph.cycles.length} dependency cycle{graph.cycles.length === 1 ? '' : 's'} detected. Affected tasks can never become ready until the plan is corrected.
          </div>
        ) : null}
        <div className="scroll-y overflow-auto p-2" style={{ maxHeight: '66vh' }}>
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
              {graph.edges.map((edge, index) => {
                const from = layout.positions.get(edge.from);
                const to = layout.positions.get(edge.to);
                if (!from || !to) return null;
                const x1 = from.x + 170;
                const y1 = from.y + 16;
                const x2 = to.x;
                const y2 = to.y + 16;
                const midX = (x1 + x2) / 2;
                return (
                  <path
                    key={index}
                    d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--color-line-strong)"
                    strokeWidth="1"
                    markerEnd="url(#arrow)"
                  />
                );
              })}
              <defs>
                <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--color-line-strong)" />
                </marker>
              </defs>
            </svg>
            {graph.nodes.map((node) => {
              const position = layout.positions.get(node.id)!;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setSelected(node.id === selected ? null : node.id)}
                  style={{ left: position.x, top: position.y, width: 172 }}
                  className={cx(
                    'absolute flex items-center gap-1.5 rounded-[var(--radius-sm)] border bg-surface-2 px-2 py-1 text-left transition-colors hover:bg-hover',
                    selected === node.id ? 'border-accent' : 'border-line',
                  )}
                  title={`${node.title}\n${node.agentId} · ${node.status}`}
                >
                  <StatusDot tone={STATUS_TONE[node.status] ?? 'unknown'} pulse={node.status === 'running'} />
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] leading-4 text-ink">{node.title}</span>
                    <span className="block truncate text-[10px] leading-3 text-faint">
                      {node.agentId} · {node.status}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      <div className="space-y-3">
        <Panel>
          <div className="panel-header">Legend</div>
          <ul className="space-y-1 px-3 py-2 text-[11px]">
            {Object.entries(STATUS_TONE).map(([status, tone]) => (
              <li key={status} className="flex items-center gap-2">
                <StatusDot tone={tone} />
                <span className="text-muted">{status.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <div className="panel-header">{selectedNode ? 'Task detail' : 'Select a task'}</div>
          {selectedNode ? (
            <div className="space-y-1.5 px-3 py-2 text-[11px]">
              <div className="text-[12px] text-ink">{selectedNode.title}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={STATUS_TONE[selectedNode.status] ?? 'neutral'}>{selectedNode.status.replace(/_/g, ' ')}</Badge>
                <Badge tone="neutral">{selectedNode.taskType.replace(/_/g, ' ')}</Badge>
                <Badge tone="neutral">depth {selectedNode.depth}</Badge>
              </div>
              <div>
                <span className="text-faint">Agent: </span>
                <AgentLink agentId={selectedNode.agentId as AgentId} />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-faint">Depends on</div>
                {selectedNode.dependsOn.length ? (
                  <ul className="space-y-0.5">
                    {selectedNode.dependsOn.map((id) => {
                      const parent = graph.nodes.find((node) => node.id === id);
                      return (
                        <li key={id}>
                          {parent?.status === 'done' ? '✓' : '○'} {parent?.title ?? id}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="text-muted">nothing — this is an entry point</div>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-faint">Unblocks</div>
                {graph.edges.filter((edge) => edge.from === selectedNode.id).length ? (
                  <ul className="space-y-0.5">
                    {graph.edges
                      .filter((edge) => edge.from === selectedNode.id)
                      .map((edge) => (
                        <li key={edge.to}>{graph.nodes.find((node) => node.id === edge.to)?.title ?? edge.to}</li>
                      ))}
                  </ul>
                ) : (
                  <div className="text-muted">nothing</div>
                )}
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 text-[11px] text-muted">Click a node to see what it depends on and what it unblocks.</div>
          )}
        </Panel>

        <Panel>
          <div className="panel-header">By agent</div>
          <ul className="divide-y divide-line/40 text-[11px]">
            {[...new Set(graph.nodes.map((node) => node.agentId))].sort().map((agentId) => {
              const nodes = graph.nodes.filter((node) => node.agentId === agentId);
              const done = nodes.filter((node) => node.status === 'done').length;
              return (
                <li key={agentId} className="flex items-center justify-between gap-2 px-3 py-1">
                  <AgentLink agentId={agentId as AgentId} />
                  <Mono>
                    {done}/{nodes.length}
                  </Mono>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
