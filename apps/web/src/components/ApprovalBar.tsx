import { useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Badge, Button, cx, Input } from '@aido/ui';
import { useApprovalActions, useApprovals } from '../lib/api.js';
import type { ApprovalRequest } from '@aido/types';

/**
 * Approvals are a first-class part of the product, not a dialog buried in a log (§24).
 *
 * A dangerous action blocks the agent that requested it, so the request is shown in a
 * persistent bar above the content, with the risk level, the exact action, and an
 * explicit scope choice: approve once, or approve this action for the rest of the task.
 * Denying is always available and equally prominent.
 */
export function ApprovalBar(): ReactNode {
  const approvals = useApprovals();
  const decide = useApprovalActions();
  const [note, setNote] = useState('');

  const pending = approvals.data ?? [];
  if (!pending.length) return null;

  return (
    <div className="border-b border-warn/40 bg-warn/5">
      {pending.map((approval) => (
        <ApprovalRow
          key={approval.id}
          approval={approval}
          busy={decide.isPending}
          note={note}
          onNote={setNote}
          onDecide={(approved, scope) =>
            decide.mutate(
              { approvalId: approval.id, approved, scope, note: note || undefined },
              { onSuccess: () => setNote('') },
            )
          }
        />
      ))}
    </div>
  );
}

function riskTone(risk: string): 'warn' | 'danger' | 'neutral' {
  if (risk === 'high' || risk === 'critical') return 'danger';
  if (risk === 'medium') return 'warn';
  return 'neutral';
}

function ApprovalRow({
  approval,
  busy,
  note,
  onNote,
  onDecide,
}: {
  approval: ApprovalRequest;
  busy: boolean;
  note: string;
  onNote: (value: string) => void;
  onDecide: (approved: boolean, scope: 'once' | 'task') => void;
}): ReactNode {
  const payload = (approval.payload ?? {}) as { detail?: string; path?: string; command?: string };
  return (
    <div className={cx('flex flex-wrap items-start gap-3 px-3 py-2', 'border-b border-warn/20 last:border-b-0')}>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-ink">{approval.action}</span>
            <Badge tone={riskTone(approval.risk)}>{approval.risk} risk</Badge>
            <span className="text-[11px] text-faint">
              requested by {approval.agentId ?? 'an agent'} · {approval.taskId ? `task ${approval.taskId.slice(0, 8)}` : 'project level'}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-muted">{approval.reason || 'This action needs your confirmation before it can continue.'}</div>
          {payload.command ? <pre className="mt-1 max-h-24 overflow-auto rounded bg-inset px-2 py-1 text-[11px] text-ink">{payload.command}</pre> : null}
          {payload.path ? <div className="mt-0.5 text-[11px] text-faint">path: {payload.path}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Input value={note} onChange={(event) => onNote(event.target.value)} placeholder="note (optional)" className="w-40" aria-label="Decision note" />
        <Button variant="default" disabled={busy} onClick={() => onDecide(true, 'task')} title="Approve this action for the rest of the task">
          approve for task
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => onDecide(true, 'once')}>
          approve once
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => onDecide(false, 'once')}>
          deny
        </Button>
      </div>
    </div>
  );
}
