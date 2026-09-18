import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, cx, EmptyState, ErrorState, formatNumber, formatTokens, Input, LoadingRows, Panel, QuotaTypeBadge, Select } from '@aido/ui';
import { TASK_TYPES, type ModelInfo, type TaskType } from '@aido/types';
import { api, useModels, useProviders } from '../lib/api.js';
import { PageHeader } from '../components/common.js';

/**
 * Models (§4, §39).
 *
 * The catalogue an operator needs to audit routing decisions: what exists, how capable
 * the router believes it is, what it costs, and whether it is currently usable. Cost is
 * shown as "unknown" when the provider publishes no price — never as zero, because zero
 * would make a paid model look free and FREE ONLY mode would then select it.
 */
export function Models(): ReactNode {
  const [filter, setFilter] = useState<{ providerId?: string; taskType?: TaskType; freeOnly?: boolean; search?: string }>({});
  const models = useModels(filter);
  const providers = useProviders();
  const [expanded, setExpanded] = useState<string | null>(null);

  const list = models.data ?? [];
  const freeCount = list.filter((model) => model.quotaType === 'free_renewable' || model.quotaType === 'user_hosted').length;

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Models"
        subtitle={`${list.length} model${list.length === 1 ? '' : 's'} known · ${freeCount} usable as free`}
        actions={
          <Button
            loading={models.isFetching}
            onClick={async () => {
              const result = await api.discoverAllModels();
              const errors = result.providers.filter((entry) => entry.error);
              if (errors.length) {
                // Report partial failure explicitly: a silent success would hide that
                // some providers could not be queried at all.
                window.alert(`Discovery finished with errors:\n${errors.map((entry) => `${entry.providerId}: ${entry.error}`).join('\n')}`);
              }
              await models.refetch();
            }}
          >
            Discover all
          </Button>
        }
      />

      <div className="mb-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Provider</span>
          <Select value={filter.providerId ?? ''} onChange={(event) => setFilter({ ...filter, providerId: event.target.value || undefined })}>
            <option value="">all providers</option>
            {(providers.data?.providers ?? []).map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Task type</span>
          <Select value={filter.taskType ?? ''} onChange={(event) => setFilter({ ...filter, taskType: (event.target.value || undefined) as TaskType | undefined })}>
            <option value="">any</option>
            {TASK_TYPES.map((taskType) => (
              <option key={taskType} value={taskType}>
                {taskType.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-faint">Search</span>
          <Input value={filter.search ?? ''} onChange={(event) => setFilter({ ...filter, search: event.target.value || undefined })} placeholder="model id…" className="w-56" />
        </label>
        <label className="flex items-center gap-1.5 pb-1 text-[12px] text-muted">
          <input type="checkbox" checked={Boolean(filter.freeOnly)} onChange={(event) => setFilter({ ...filter, freeOnly: event.target.checked || undefined })} />
          free-capable only
        </label>
      </div>

      {models.isLoading ? <LoadingRows rows={8} /> : null}
      {models.error ? <ErrorState title="Models could not be loaded" detail={(models.error as Error).message} retry={() => void models.refetch()} /> : null}
      {models.data && list.length === 0 ? (
        <EmptyState
          title="No models match"
          detail="Providers publish their catalogues over their own APIs. Add credentials for a provider and run Discover, or relax the filters. A provider that could not be queried keeps its last known catalogue and stays disabled until it has one."
        />
      ) : null}

      {list.length > 0 ? (
        <Panel className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Class</th>
                <th>Context</th>
                <th>Cost / 1M in–out</th>
                <th>Capabilities</th>
                <th>Quality prior</th>
                <th>Status</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {list.map((model) => (
                <ModelRow key={model.id} model={model} expanded={expanded === model.id} onToggle={() => setExpanded(expanded === model.id ? null : model.id)} />
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      <p className="mt-3 text-[11px] text-faint">
        Capability flags come from the provider's metadata where it publishes them, and from the shipped definition otherwise. A flag that is not established is shown as not supported rather than assumed —
        routing prefers a model that declares the capability the task needs.
      </p>
    </div>
  );
}

function ModelRow({ model, expanded, onToggle }: { model: ModelInfo; expanded: boolean; onToggle: () => void }): ReactNode {
  const capabilities = Object.entries(model.capabilities).filter(([, supported]) => supported);
  return (
    <>
      <tr className={cx('row-hover', expanded && 'bg-hover')}>
        <td className="max-w-[280px]">
          <button type="button" onClick={onToggle} className="block w-full truncate text-left text-ink hover:text-accent" title={model.id}>
            {model.providerModelId}
          </button>
          <div className="truncate text-[10px] text-faint">{model.displayName}</div>
        </td>
        <td>
          <Link to={`/providers/${model.providerId}`} className="text-accent hover:underline">
            {model.providerId}
          </Link>
        </td>
        <td>
          <QuotaTypeBadge type={model.quotaType} />
        </td>
        <td className="tabular">{model.contextWindow ? formatTokens(model.contextWindow) : '—'}</td>
        <td className="tabular text-[11px]">
          {model.pricing.inputPerMillionTokens === null && model.pricing.outputPerMillionTokens === null ? (
            <span className="text-faint" title={`Provenance: ${model.pricing.provenance}. An unknown price means FREE ONLY mode will not select this model.`}>
              unknown
            </span>
          ) : (
            `${model.pricing.inputPerMillionTokens === 0 ? 'free' : `$${model.pricing.inputPerMillionTokens}`} / ${
              model.pricing.outputPerMillionTokens === 0 ? 'free' : `$${model.pricing.outputPerMillionTokens}`
            }`
          )}
        </td>
        <td className="max-w-[240px]">
          <div className="flex flex-wrap gap-1">
            {capabilities.slice(0, 4).map(([capability]) => (
              <span key={capability} className="rounded bg-inset px-1 py-0.5 text-[10px] text-faint">
                {capability}
              </span>
            ))}
            {capabilities.length > 4 ? <span className="text-[10px] text-faint">+{capabilities.length - 4}</span> : null}
            {capabilities.length === 0 ? <span className="text-[10px] text-faint">none declared</span> : null}
          </div>
        </td>
        <td className="tabular">{formatNumber(model.qualityPrior, { digits: 2 })}</td>
        <td>
          <Badge tone={model.status === 'online' ? 'free' : model.status === 'degraded' ? 'warn' : model.status === 'unknown' ? 'unknown' : 'danger'}>{model.status}</Badge>
        </td>
        <td>
          <input
            type="checkbox"
            checked={model.enabled}
            aria-label={`Enable ${model.id}`}
            onChange={async () => {
              await api.patchModel(model.id, { enabled: !model.enabled });
            }}
          />
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={9} className="bg-inset">
            <div className="grid gap-3 px-3 py-2 md:grid-cols-3">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">All capabilities</div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(model.capabilities).map(([capability, supported]) => (
                    <span key={capability} className={cx('rounded px-1 py-0.5 text-[10px]', supported ? 'bg-free/10 text-free' : 'bg-surface-2 text-faint')}>
                      {supported ? '✓' : '✗'} {capability}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Model quota limits</div>
                <ul className="space-y-0.5 text-[11px] text-muted">
                  {Object.entries(model.quota)
                    .filter(([, value]) => typeof value === 'number')
                    .map(([key, value]) => (
                      <li key={key} className="flex justify-between gap-2">
                        <span>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                        <span className="tabular text-ink">{formatNumber(value as number)}</span>
                      </li>
                    ))}
                  {Object.values(model.quota).every((value) => typeof value !== 'number') ? <li className="text-faint">No per-model limits published.</li> : null}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Evidence</div>
                <ul className="space-y-0.5 text-[11px] text-muted">
                  <li>Strengths: {model.strengths.length ? model.strengths.map((strength) => strength.replace(/_/g, ' ')).join(', ') : 'none recorded'}</li>
                  <li>Discovered: {new Date(model.discoveredAt).toLocaleString()}</li>
                  <li>Priority: {model.priority}</li>
                </ul>
                <p className="mt-1 text-[10px] text-faint">
                  Task-type compatibility is measured from real attempts: after five runs of a task type on a model, the router prefers the observed success rate over the prior.
                </p>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
