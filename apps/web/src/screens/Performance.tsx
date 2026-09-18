import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, BarSeries, ErrorState, formatCost, formatNumber, formatPercent, formatTokens, LoadingRows, Panel, Select, Sparkline, Stat } from '@aido/ui';
import { usePerformance } from '../lib/api.js';
import { AgentLink, Mono, PageHeader, Section } from '../components/common.js';

/**
 * Performance (§36, §39): the self-monitoring view.
 *
 * Three families of numbers, kept apart because they answer different questions:
 *   - AI: tokens, latency, cost, success rate per provider/model;
 *   - software: system metrics (memory, CPU, disk) and their trend;
 *   - agents: throughput and success per role.
 *
 * Every series is rendered from real samples. Where the window contains no samples the
 * panel says so instead of drawing a flat line at zero.
 */
export function Performance(): ReactNode {
  const [days, setDays] = useState(7);
  const performance = usePerformance(days);

  if (performance.isLoading) return <LoadingRows rows={8} />;
  if (performance.error) return <ErrorState title="Performance data could not be loaded" detail={(performance.error as Error).message} retry={() => void performance.refetch()} />;
  const data = performance.data!;

  const points = (series: { points: { bucket: string; value: number }[] }): number[] => series.points.map((point) => point.value);
  const bars = (series: { points: { bucket: string; value: number }[] }): { label: string; value: number }[] =>
    series.points.map((point) => ({ label: point.bucket, value: point.value }));

  const costKnown = data.totals.requests > 0;

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Performance"
        subtitle={`Window since ${new Date(data.since).toLocaleString()}`}
        actions={
          <Select value={String(days)} onChange={(event) => setDays(Number(event.target.value))} aria-label="Window">
            {[1, 7, 30, 90].map((value) => (
              <option key={value} value={value}>
                last {value} day{value === 1 ? '' : 's'}
              </option>
            ))}
          </Select>
        }
      />

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Panel>
          <Stat label="Requests" value={formatNumber(data.totals.requests)} />
        </Panel>
        <Panel>
          <Stat label="Input tokens" value={formatTokens(data.totals.tokensIn)} />
        </Panel>
        <Panel>
          <Stat label="Output tokens" value={formatTokens(data.totals.tokensOut)} />
        </Panel>
        <Panel>
          <Stat label="Average latency" value={data.totals.avgLatencyMs ? `${formatNumber(data.totals.avgLatencyMs)} ms` : '—'} />
        </Panel>
        <Panel>
          <Stat
            label="Success rate"
            value={data.totals.requests ? formatPercent(data.totals.successRate) : '—'}
            tone={data.totals.successRate >= 0.95 ? 'positive' : data.totals.successRate >= 0.8 ? 'warning' : 'danger'}
            hint={`${data.totals.failovers} failover${data.totals.failovers === 1 ? '' : 's'}`}
          />
        </Panel>
        <Panel>
          <Stat
            label="Estimated cost"
            value={formatCost(data.cost.total)}
            hint={costKnown ? (data.cost.total === 0 ? 'all recorded calls used free or simulated models' : 'from provider pricing where known') : 'no calls in this window'}
          />
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Section title="Latency trend">
          <div className="px-3 py-2">
            {data.latency.points.length ? <Sparkline values={points(data.latency)} tone="accent" height={90} /> : <EmptySeries name="latency" />}
            <div className="mt-1 flex justify-between text-[11px] text-faint">
              <span>{data.latency.points.length} samples</span>
              <span className="tabular">avg {data.latency.average !== null ? `${formatNumber(data.latency.average)} ms` : '—'}</span>
            </div>
          </div>
        </Section>
        <Section title="Throughput (requests per bucket)">
          <div className="px-3 py-2">
            {data.throughput.points.length ? <BarSeries data={bars(data.throughput)} tone="free" height={90} /> : <EmptySeries name="throughput" />}
            <div className="mt-1 flex justify-between text-[11px] text-faint">
              <span>{data.throughput.points.length} buckets</span>
              <span className="tabular">total {formatNumber(data.throughput.total)}</span>
            </div>
          </div>
        </Section>
        <Section title="Tokens">
          <div className="px-3 py-2">
            {data.tokens.points.length ? <BarSeries data={bars(data.tokens)} tone="accent" height={90} /> : <EmptySeries name="token usage" />}
            <div className="mt-1 text-[11px] text-faint">
              total {formatTokens(data.tokens.total)} across providers, {formatTokens(data.tokens.total ? data.totals.tokensIn : 0)} input and {formatTokens(data.tokens.total ? data.totals.tokensOut : 0)} output.
            </div>
          </div>
        </Section>
        <Section title="System memory (MiB, resident)">
          <div className="px-3 py-2">
            {data.systemMetrics.points.length ? <Sparkline values={points(data.systemMetrics)} tone="hosted" height={90} /> : <EmptySeries name="system metrics" />}
            <div className="mt-1 text-[11px] text-faint">
              {data.systemMetrics.points.length
                ? `latest ${formatNumber(data.systemMetrics.points.at(-1)?.value ?? 0)} ${data.systemMetrics.unit || 'MiB'} · average ${data.systemMetrics.average !== null ? formatNumber(data.systemMetrics.average) : '—'}`
                : 'The collector writes a sample while it runs; a freshly started instance has no history yet.'}
            </div>
          </div>
        </Section>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Section title="By provider">
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Requests</th>
                <th>Success</th>
                <th>Avg latency</th>
                <th>Tokens in / out</th>
                <th>Failovers</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((provider) => (
                <tr key={provider.providerId} className="row-hover">
                  <td>
                    <Link to={`/providers/${provider.providerId}`} className="text-accent hover:underline">
                      {provider.providerId}
                    </Link>
                  </td>
                  <td className="tabular">{provider.requests}</td>
                  <td className="tabular">
                    <Badge tone={provider.successRate >= 0.95 ? 'free' : provider.successRate >= 0.8 ? 'warn' : 'danger'}>{formatPercent(provider.successRate)}</Badge>
                  </td>
                  <td className="tabular">{formatNumber(provider.avgLatencyMs)} ms</td>
                  <td className="tabular">
                    {formatTokens(provider.tokensIn)} / {formatTokens(provider.tokensOut)}
                  </td>
                  <td className="tabular">{provider.failovers}</td>
                </tr>
              ))}
              {data.providers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-muted">
                    No provider has served a request in this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Section>

        <Section title="By agent">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Requests</th>
                <th>Tasks done</th>
                <th>Success</th>
                <th>Tokens in / out</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((agent) => (
                <tr key={agent.agentId} className="row-hover">
                  <td>
                    <AgentLink agentId={agent.agentId} />
                  </td>
                  <td className="tabular">{agent.requests}</td>
                  <td className="tabular">{agent.tasksCompleted}</td>
                  <td className="tabular">
                    <Badge tone={agent.successRate >= 0.95 ? 'free' : agent.successRate >= 0.8 ? 'warn' : 'danger'}>{formatPercent(agent.successRate)}</Badge>
                  </td>
                  <td className="tabular">
                    {formatTokens(agent.tokensIn)} / {formatTokens(agent.tokensOut)}
                  </td>
                </tr>
              ))}
              {data.agents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted">
                    No agent has made a model call in this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Section>

        <Section title="By model" className="lg:col-span-2">
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Requests</th>
                <th>Success</th>
                <th>Avg latency</th>
                <th>Tokens in / out</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((model) => (
                <tr key={model.modelId} className="row-hover">
                  <td className="max-w-[380px] truncate">
                    <Mono>{model.modelId}</Mono>
                  </td>
                  <td className="tabular">{model.requests}</td>
                  <td className="tabular">
                    <Badge tone={model.successRate >= 0.95 ? 'free' : model.successRate >= 0.8 ? 'warn' : 'danger'}>{formatPercent(model.successRate)}</Badge>
                  </td>
                  <td className="tabular">{formatNumber(model.avgLatencyMs)} ms</td>
                  <td className="tabular">
                    {formatTokens(model.tokensIn)} / {formatTokens(model.tokensOut)}
                  </td>
                </tr>
              ))}
              {data.models.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted">
                    No model has served a request in this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Section>

        <Section title="Failures by category" className="lg:col-span-2">
          {data.failures.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Count</th>
                  <th>What the orchestrator did</th>
                </tr>
              </thead>
              <tbody>
                {data.failures.map((failure) => (
                  <tr key={failure.category} className="row-hover">
                    <td>
                      <Badge tone="danger">{failure.category.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="tabular">{failure.count}</td>
                    <td className="text-muted">{CATEGORY_RESPONSE[failure.category] ?? 'Recorded; see the trace for the exact decision.'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-3 py-4 text-[12px] text-muted">No failed model call in this window.</div>
          )}
        </Section>
      </div>
    </div>
  );
}

function EmptySeries({ name }: { name: string }): ReactNode {
  return <div className="grid h-[90px] place-items-center rounded bg-inset text-[11px] text-faint">no {name} samples in this window</div>;
}

/**
 * What the taxonomy does about each category (§35). Kept short and factual: it explains
 * the behaviour an operator just observed rather than restating the error name.
 */
const CATEGORY_RESPONSE: Record<string, string> = {
  timeout: 'Retried on the same model, then failed over to another provider.',
  rate_limit: 'Waited out the provider’s cooldown and failed over; the limit is learned from the response.',
  quota_exhausted: 'Never retried: the quota engine marked the window exhausted and the router switched provider.',
  authentication: 'Not retried. The credential is marked rejected and the provider is skipped until it is replaced.',
  invalid_request: 'Not retried. The request content or shape is wrong, so the task failed with this reason.',
  context_length: 'Not retried. The context builder compressed the prompt on the next attempt.',
  server_error: 'Retried with backoff, then failed over.',
  model_unavailable: 'Failed over to the next eligible model immediately.',
  network_error: 'Retried with backoff; repeated failures open the provider’s circuit breaker.',
  content_filter: 'Not retried: the same content would be refused again. The task failed with this reason.',
  cancelled: 'Stopped by the operator or by a hard limit; no retry.',
  unknown: 'Recorded with its raw message; the supervisor decides based on the attempt count.',
};
