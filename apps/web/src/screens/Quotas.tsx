import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Badge, Button, ErrorState, formatCountdown, formatNumber, formatPercent, formatRelativeTime, formatTokens, LoadingRows, Panel, ProgressBar, QuotaTypeBadge, StatusDot } from '@aido/ui';
import { useQuotas, useQuotaActions } from '../lib/api.js';
import { healthTone, PageHeader } from '../components/common.js';

/**
 * Quotas (§9, §39).
 *
 * The screen exists to make three things unmissable:
 *   1. what is actually left, per provider and per window;
 *   2. when it resets — with the provider's own reset semantics, not an assumed UTC midnight;
 *   3. what FREE ONLY mode will and will not spend, including anything excluded.
 *
 * Reservations are shown because they are the mechanism that prevents two agents from
 * planning on the same remaining requests; "open" is capacity committed but not yet
 * reported as used by the provider.
 */
export function Quotas(): ReactNode {
  const quotas = useQuotas();
  const actions = useQuotaActions();

  if (quotas.isLoading) return <LoadingRows rows={8} />;
  if (quotas.error) return <ErrorState title="Quota state could not be loaded" detail={(quotas.error as Error).message} retry={() => void quotas.refetch()} />;
  const data = quotas.data!;

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Quotas"
        subtitle={`${data.snapshots.length} provider snapshot${data.snapshots.length === 1 ? '' : 's'} · reserve floor ${formatPercent(data.reserveFraction)} of each window`}
        actions={
          <>
            <Button
              icon={<RefreshCw className="size-3.5" />}
              loading={actions.refresh.isPending}
              onClick={async () => {
                for (const snapshot of data.snapshots) {
                  // Refresh only providers that can report usage; the rest return why not.
                  await actions.refresh.mutateAsync(snapshot.providerId).catch(() => undefined);
                }
                await quotas.refetch();
              }}
            >
              Refresh all
            </Button>
            {data.freeOnlyMode ? <Badge tone="free">FREE ONLY active</Badge> : <Badge tone="unknown">FREE ONLY off</Badge>}
          </>
        }
      />

      <div className="mb-3 grid gap-3 md:grid-cols-4">
        <Panel className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-faint">Estimated requests left</div>
          <div className="tabular text-[17px]">{formatNumber(data.capacity.totalRemainingRequests, { compact: true })}</div>
          <div className="text-[11px] text-faint">
            across {data.capacity.activeProviders} of {data.capacity.totalProviders} providers
          </div>
        </Panel>
        <Panel className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-faint">Estimated tokens left</div>
          <div className="tabular text-[17px]">{formatTokens(data.capacity.totalRemainingTokens)}</div>
          <div className="text-[11px] text-faint">{data.excludeTrialCredits ? 'trial credits excluded' : 'trial credits included'}</div>
        </Panel>
        <Panel className="px-3 py-2 md:col-span-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">How this estimate is produced</div>
          <ul className="space-y-0.5 text-[11px] text-muted">
            {data.capacity.basis.slice(0, 4).map((line, index) => (
              <li key={index}>· {line}</li>
            ))}
            {data.capacity.basis.length === 0 ? <li className="text-faint">No provider is currently reporting usable capacity.</li> : null}
          </ul>
        </Panel>
      </div>

      {data.capacity.excluded.length ? (
        <Panel className="mb-3">
          <div className="panel-header">Excluded from free capacity</div>
          <ul className="divide-y divide-line/40">
            {data.capacity.excluded.map((entry) => (
              <li key={entry.providerId} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]">
                <Link to={`/providers/${entry.providerId}`} className="text-accent hover:underline">
                  {entry.providerId}
                </Link>
                <span className="text-muted">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div className="grid gap-2 xl:grid-cols-2">
        {data.snapshots.map((snapshot) => {
          const remainingFraction = snapshot.remainingFraction;
          return (
            <Panel key={`${snapshot.providerId}-${snapshot.modelId ?? 'provider'}`} className="flex flex-col">
              <div className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/providers/${snapshot.providerId}`} className="text-[13px] font-medium text-ink hover:text-accent">
                      {snapshot.providerId}
                    </Link>
                    <QuotaTypeBadge type={snapshot.quotaType} />
                    <span className="flex items-center gap-1 text-[11px]" title={`provenance: ${snapshot.provenance}`}>
                      <StatusDot tone={snapshot.remaining === 0 ? 'danger' : snapshot.cooldownUntil ? 'warn' : 'unknown'} />
                      {snapshot.remaining === 0 ? 'exhausted' : snapshot.cooldownUntil ? 'cooling down' : `${snapshot.provenance} data`}
                    </span>
                  </div>
                  {snapshot.modelId ? <div className="mt-0.5 truncate text-[11px] text-faint">{snapshot.modelId}</div> : null}
                </div>
                <Button
                  variant="ghost"
                  loading={actions.refresh.isPending}
                  onClick={() => actions.refresh.mutate(snapshot.providerId)}
                  title="Ask the provider for its current usage, where the provider exposes it"
                >
                  refresh
                </Button>
              </div>

              <div className="flex-1 space-y-2 px-3 py-2">
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-faint">
                      {snapshot.used === null ? 'used: not reported' : `used ${formatNumber(snapshot.used)} of ${formatNumber(snapshot.limit)}`}
                    </span>
                    <span className="tabular text-ink">{remainingFraction === null ? 'unknown' : `${formatPercent(remainingFraction)} left`}</span>
                  </div>
                  <ProgressBar
                    value={remainingFraction ?? 0}
                    tone={snapshot.remaining === 0 ? 'danger' : (remainingFraction ?? 1) < 0.25 ? 'warn' : 'free'}
                    label={`${snapshot.providerId} remaining`}
                  />
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  <Row label="Window" value={snapshot.window ?? '—'} />
                  <Row label="Resets" value={snapshot.resetsAt ? `${formatCountdown(snapshot.resetsAt)} (${formatRelativeTime(snapshot.resetsAt)})` : 'unknown'} />
                  <Row label="Reset strategy" value={snapshot.resetStrategy.replace(/_/g, ' ')} />
                  <Row label="Reset is" value={snapshot.resetIsEstimated ? 'estimated from the strategy' : 'reported by the provider'} />
                  <Row label="Remaining" value={snapshot.remaining === null ? 'unknown' : formatNumber(snapshot.remaining)} />
                  <Row label="Unit" value={snapshot.window.replace(/_/g, ' ')} />
                  <Row label="Provenance" value={String(snapshot.provenance)} />
                  <Row label="Cooldown" value={snapshot.cooldownUntil ? formatCountdown(snapshot.cooldownUntil) : 'none'} />
                </div>

                {snapshot.remaining === 0 ? (
                  <div className="rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
                    This window is exhausted. The router will not send a request here until the window resets; work continues on another provider if one is eligible.
                  </div>
                ) : null}
                {snapshot.remaining === null || snapshot.limit === null ? (
                  <div className="text-[11px] text-faint">
                    The provider does not publish this limit. It is recorded as unknown — never assumed unlimited — and{' '}
                    {data.freeOnlyMode ? 'FREE ONLY mode will not plan against it' : 'the router treats it as unusable for planning'}.
                  </div>
                ) : null}
              </div>
            </Panel>
          );
        })}
      </div>

      {data.snapshots.length === 0 ? (
        <Panel className="p-6 text-center text-[12px] text-muted">
          No provider has reported quota yet. Add credentials and run a health check; anything a provider reports in a response header is learned automatically from the first real request.
        </Panel>
      ) : null}

      <p className="mt-3 text-[11px] text-faint">
        Limits learned from a provider's own responses always take precedence over the values shipped in this repository. Nothing here is an estimate of a provider's published free tier unless its source says so.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-faint">{label}</span>
      <span className="max-w-[60%] truncate text-right text-ink" title={typeof value === 'string' ? value : undefined}>
        {value}
      </span>
    </div>
  );
}
