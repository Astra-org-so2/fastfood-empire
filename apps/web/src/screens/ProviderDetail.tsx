import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import { Badge, Button, cx, ErrorState, formatDateTime, formatNumber, formatTokens, Input, LoadingRows, QuotaTypeBadge, Select, StatusDot, formatPercent } from '@aido/ui';
import type { ProviderSummary } from '@aido/providers';
import type { ModelInfo } from '@aido/types';
import { api, useModels, useProvider, useQuota, useQuotaActions } from '../lib/api.js';
import { credentialLabel, healthTone, KeyValue, Mono, Section, TimeAgo } from '../components/common.js';

/**
 * Provider detail: credentials, models, quota state and the raw definition.
 *
 * Two things are deliberate here. First, keys are write-only — the form can replace a
 * key, and the UI can show that one exists, but the value never comes back from the API.
 * Second, the quota limits are editable: because published free-tier numbers change and
 * are sometimes contradictory, the operator must be able to correct them, and any value
 * the runtime learned from a real response is labelled as such.
 */
export function ProviderDetail(): ReactNode {
  const { providerId } = useParams<{ providerId: string }>();
  const provider = useProvider(providerId);
  const quota = useQuota(providerId);
  const models = useModels({ providerId });
  const quotaActions = useQuotaActions();
  const navigate = useNavigate();
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (provider.isLoading) return <LoadingRows rows={8} />;
  if (provider.error) return <ErrorState title="Provider could not be loaded" detail={(provider.error as Error).message} retry={() => void provider.refetch()} />;
  const data = provider.data!;

  const run = async (key: string, action: () => Promise<string>): Promise<void> => {
    setBusy(key);
    try {
      setToast(await action());
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await provider.refetch();
      await quota.refetch();
    }
  };

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="mb-3">
        <button type="button" onClick={() => navigate('/providers')} className="text-[11px] text-accent hover:underline">
          ← Providers
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {data.name}
            <QuotaTypeBadge type={data.freeTier?.quotaType ?? null} />
            <span className="flex items-center gap-1 text-[11px] font-normal">
              <StatusDot tone={healthTone(data.health.status)} />
              {data.health.status}
              {data.health.latencyMs !== null ? <span className="tabular text-faint">· {data.health.latencyMs} ms</span> : null}
            </span>
          </h1>
          <p className="mt-0.5 text-[12px] text-muted">
            {data.kind.replace(/_/g, ' ')} adapter · <Mono>{String(data.definition?.apiBaseUrl ?? 'no base URL')}</Mono>
            {data.definition?.documentationUrl ? (
              <>
                {' · '}
                <a href={String(data.definition.documentationUrl)} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                  documentation <ExternalLink className="inline size-3" />
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            loading={busy === 'health'}
            onClick={() =>
              void run('health', async () => {
                const result = await api.providerHealth(data.id);
                return `${data.name}: ${result.status}${result.message ? ` — ${result.message}` : ''}`;
              })
            }
          >
            Health check
          </Button>
          <Button
            loading={busy === 'test'}
            onClick={() =>
              void run('test', async () => {
                const result = await api.testProvider(data.id);
                return `${data.name}: ${result.detail}`;
              })
            }
          >
            Test credentials
          </Button>
          <Button
            loading={busy === 'discover'}
            onClick={() =>
              void run('discover', async () => {
                const result = await api.discoverModels(data.id);
                return result.error ? `Discovery failed: ${result.error}` : `${result.added} added, ${result.updated} updated.`;
              })
            }
          >
            Discover models
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await api.patchProvider(data.id, { enabled: !data.enabled });
              await provider.refetch();
            }}
          >
            {data.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </div>

      {toast ? (
        <div className="mb-3 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted">
          {toast}
          <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setToast(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      {!data.metadataVerified ? (
        <div className="mb-3 rounded-[var(--radius-md)] border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] text-warn">
          The model list and quota figures shipped with this definition have not been verified against the provider's current documentation. Treat them as a starting point: use{' '}
          <em>Discover models</em> to read them from the provider, and correct the limits below if the provider reports different numbers.
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Credentials">
          <div className="space-y-2 px-3 py-2.5">
            {data.credentials && data.credentials.length > 0 ? (
              <ul className="space-y-1">
                {data.credentials.map((credential) => (
                  <li key={credential.key} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="flex items-center gap-2">
                      <Mono>{credential.key}</Mono>
                      <Badge tone="free">stored</Badge>
                      <span className="text-[10px] text-faint">fingerprint {credential.fingerprint}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] text-faint">{credential.createdAt ? `added ${formatDateTime(credential.createdAt)}` : ''}</span>
                      <Button
                        variant="ghost"
                        icon={<Trash2 className="size-3.5" />}
                        title="Delete this credential"
                        onClick={() =>
                          void run('delete', async () => {
                            await api.deleteCredential(data.id, credential.key);
                            return `Deleted credential ${credential.key}.`;
                          })
                        }
                      />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-muted">No credentials are stored for this provider.</p>
            )}
            <CredentialForm providerId={data.id} providerName={data.name} fields={credentialFieldsOf(data)} onDone={(message) => setToast(message)} />
            <p className="text-[11px] text-faint">
              Credentials are encrypted at rest with this installation's master key and are never returned by the API, never written to logs, and never sent to another provider.
            </p>
          </div>
        </Section>

        <Section
          title="Quota"
          actions={
            <>
              <Button
                variant="ghost"
                icon={<RefreshCw className="size-3.5" />}
                loading={busy === 'refresh'}
                onClick={() =>
                  void run('refresh', async () => {
                    const result = await api.refreshQuota(data.id);
                    return result.detail;
                  })
                }
              >
                Refresh from provider
              </Button>
              <Link to="/quotas" className="text-[11px] text-accent hover:underline">
                all quotas
              </Link>
            </>
          }
        >
          <div className="space-y-2 px-3 py-2.5 text-[12px]">
            {quota.data ? (
              <>
                <KeyValue
                  columns={2}
                  items={[
                    { label: 'Quota class', value: <QuotaTypeBadge type={quota.data.provider.freeTier.quotaType} /> },
                    {
                      label: 'Reset strategy',
                      value:
                        quota.data.providerLimits.resetStrategy.replace(/_/g, ' ') +
                        (quota.data.providerLimits.resetTimezone ? ` (${quota.data.providerLimits.resetTimezone})` : ''),
                    },
                    {
                      label: 'Limits source',
                      value: `${quota.data.providerLimits.provenance.source.replace(/_/g, ' ')} (confidence ${formatPercent(quota.data.providerLimits.provenance.confidence)})`,
                    },
                    {
                      label: 'Observed (live)',
                      value:
                        (quota.data.observations?.length ?? 0) > 0 ? (
                          <span>
                            {quota.data.observations![0]!.tokensRemaining === null ? '—' : formatTokens(quota.data.observations![0]!.tokensRemaining)} tokens,{' '}
                            {quota.data.observations![0]!.requestsRemaining === null ? '—' : formatNumber(quota.data.observations![0]!.requestsRemaining)} requests remaining{' '}
                            <span className="text-faint">
                              ({quota.data.observations![0]!.source.replace(/_/g, ' ')}, {formatDateTime(quota.data.observations![0]!.observedAt)})
                            </span>
                          </span>
                        ) : (
                          <span className="text-faint">
                            Nothing yet. Any value reported by the provider in a response header or usage endpoint is recorded here automatically.
                          </span>
                        ),
                    },
                  ]}
                />

                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Effective limits</div>
                  {Object.values(quota.data.providerLimits).some((value) => typeof value === 'number') ? (
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(quota.data.providerLimits)
                        .filter(([, value]) => typeof value === 'number')
                        .map(([key, value]) => (
                          <span key={key} className="rounded bg-inset px-1.5 py-0.5 text-[11px]">
                            <span className="text-faint">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}: </span>
                            <span className="tabular text-ink">{formatNumber(value as number)}</span>
                          </span>
                        ))}
                    </div>
                  ) : (
                    <p className="text-muted">
                      No limits are known for this provider. Unknown is not unlimited: with <Mono>assumeUnknownIsUnlimited</Mono> off, the router refuses to plan spend against it.
                    </p>
                  )}
                </div>

                <LimitEditor
                  providerId={data.id}
                  current={quota.data.providerLimits as unknown as Record<string, number | null>}
                  onSave={(limits) =>
                    void run('limits', async () => {
                      const result = await quotaActions.setLimits.mutateAsync({ providerId: data.id, limits });
                      await quota.refetch();
                      return result.detail;
                    })
                  }
                  saving={busy === 'limits'}
                />

                {(quota.data.buckets?.length ?? 0) > 0 ? (
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Recent usage buckets (this installation)</div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Bucket</th>
                          <th>Requests</th>
                          <th>Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {quota.data.buckets.slice(-8).map((bucket) => (
                          <tr key={`${bucket.providerId}-${bucket.modelId ?? ''}-${bucket.window}-${bucket.windowStart}`}>
                            <td>
                              <Mono>{new Date(bucket.windowStart).toLocaleString()}</Mono>
                              <span className="ml-1 text-[10px] text-faint">{bucket.window.replace(/_/g, ' ')}</span>
                            </td>
                            <td className="tabular">{formatNumber(bucket.usedRequests)}</td>
                            <td className="tabular">{formatTokens(bucket.usedTokens)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </>
            ) : (
              <LoadingRows rows={5} />
            )}
          </div>
        </Section>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Section title={`Models (${models.data?.length ?? 0})`} className="lg:col-span-2">
          {models.isLoading ? <LoadingRows rows={5} /> : null}
          {models.error ? <ErrorState title="Models could not be loaded" detail={(models.error as Error).message} /> : null}
          {models.data ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Class</th>
                  <th>Context</th>
                  <th>Capabilities</th>
                  <th>Cost / 1M</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {models.data.map((model) => (
                  <tr key={model.id} className="row-hover">
                    <td className="max-w-[260px]">
                      <div className="truncate text-ink">{model.id.split(':')[1] ?? model.id}</div>
                      <div className="truncate text-[10px] text-faint">{model.displayName ?? model.id}</div>
                    </td>
                    <td>
                      <QuotaTypeBadge type={model.quotaType} title={`price provenance: ${model.pricing.provenance}`} />
                    </td>
                    <td className="tabular">{model.contextWindow ? formatTokens(model.contextWindow) : '—'}</td>
                    <td className="max-w-[220px]">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(model.capabilities)
                          .filter(([, supported]) => supported)
                          .slice(0, 4)
                          .map(([capability]) => (
                            <span key={capability} className="rounded bg-inset px-1 py-0.5 text-[10px] text-faint">
                              {capability}
                            </span>
                          ))}
                        {Object.values(model.capabilities).filter(Boolean).length === 0 ? <span className="text-[10px] text-faint">none declared</span> : null}
                      </div>
                    </td>
                    <td className="tabular text-[11px]">
                      {priceLabel(model.pricing)}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={model.enabled !== false}
                        aria-label={`Enable ${model.id}`}
                        onChange={async () => {
                          await api.patchModel(model.id, { enabled: model.enabled === false });
                          await models.refetch();
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Section>

        <Section title="Definition">
          <div className="px-3 py-2">
            <KeyValue
              columns={1}
              items={[
                { label: 'Definition id', value: <Mono>{data.id}</Mono> },
                { label: 'Adapter kind', value: data.kind },
                { label: 'Adapter', value: data.adapter.registered ? data.adapter.name : <span className="text-warn">not registered</span> },
                { label: 'Credentials required', value: (data.missingCredentialFields ?? []).length === 0 && !data.configured ? 'unknown' : 'yes' },
                { label: 'Missing fields', value: (data.missingCredentialFields ?? []).join(', ') || 'none' },
                { label: 'Environment variables', value: ((data.definition?.envKeys as string[] | undefined) ?? []).join(', ') || '—' },
                { label: 'Health endpoint', value: <Mono>{String(data.definition?.healthEndpoint ?? '—')}</Mono> },
                { label: 'Usage endpoint', value: <Mono>{String(data.definition?.usageEndpoint ?? '—')}</Mono> },
                { label: 'Metadata verified', value: data.metadataVerified ? 'yes' : 'no (editable, unverified)' },
                { label: 'Last sync', value: data.lastSyncAt ? <TimeAgo iso={data.lastSyncAt} /> : 'never' },
              ]}
            />
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-accent">raw definition JSON</summary>
              <pre className="mt-1 max-h-64 scroll-y rounded bg-inset px-2 py-1.5 text-[10px] leading-4 text-muted">{JSON.stringify(data.definition ?? {}, null, 2)}</pre>
            </details>
          </div>
        </Section>
      </div>
    </div>
  );
}

export interface CredentialFieldSpec {
  key: string;
  label?: string;
  description?: string;
  required?: boolean;
  type?: string;
}

/**
 * The credential fields a provider needs, from its definition. Falls back to a single
 * API-key field only when the definition does not say — never invented silently: the
 * caller decides what to show for a missing definition.
 */
export function credentialFieldsOf(provider: { definition?: unknown; missingCredentialFields?: string[] }): CredentialFieldSpec[] {
  const definition = provider.definition as { credentialFields?: CredentialFieldSpec[] } | undefined;
  if (definition?.credentialFields?.length) return definition.credentialFields;
  return (provider.missingCredentialFields ?? []).map((key) => ({ key, label: key, required: true, type: 'password' }));
}

/** Write-only credential entry: values are sent once and never read back. */
export function CredentialForm({
  providerId,
  providerName,
  fields,
  onDone,
}: {
  providerId: string;
  providerName: string;
  fields: CredentialFieldSpec[];
  onDone: (message: string) => void;
}): ReactNode {
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveFields = fields.length ? fields : [{ key: 'apiKey', label: 'API key', required: true, type: 'password' }];
  const missing = effectiveFields.filter((field) => field.required !== false && !values[field.key]?.trim());

  return (
    <div className="space-y-2">
      {effectiveFields.map((field) => (
        <label key={field.key} className="block">
          <span className="mb-0.5 block text-[11px] font-medium text-muted">
            {field.label ?? field.key}
            {field.required === false ? <span className="ml-1 text-faint">(optional)</span> : null}
          </span>
          <Input
            type={field.type === 'password' || !field.type ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.key}
            value={values[field.key] ?? ''}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
          />
          {field.description ? <span className="mt-0.5 block text-[11px] text-faint">{field.description}</span> : null}
        </label>
      ))}
      <label className="block">
        <span className="mb-0.5 block text-[11px] font-medium text-muted">Label (optional)</span>
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="personal account" />
      </label>
      {error ? <div className="text-[11px] text-danger">{error}</div> : null}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          loading={busy}
          disabled={missing.length > 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.setCredentials(providerId, values, label || undefined);
              setValues({});
              setLabel('');
              onDone(`Credentials stored for ${providerName}. They are encrypted at rest and will not be shown again.`);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save credentials
        </Button>
        {missing.length ? <span className="text-[11px] text-faint">required: {missing.map((field) => field.key).join(', ')}</span> : null}
      </div>
    </div>
  );
}

/** Corrects the limits this installation believes a provider has. */
function LimitEditor({
  providerId,
  current,
  onSave,
  saving,
}: {
  providerId: string;
  current: Record<string, number | null>;
  onSave: (limits: Record<string, number | null>) => void;
  saving: boolean;
}): ReactNode {
  const keys = ['requestsPerMinute', 'requestsPerHour', 'requestsPerDay', 'tokensPerMinute', 'tokensPerDay', 'concurrentRequests'] as const;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Edit limits
      </Button>
    );
  }

  return (
    <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 p-2">
      <div className="mb-1 text-[11px] text-muted">
        Leave a field empty for "not known". Setting a value marks it as user-configured, which takes precedence over the shipped default but not over a live value reported by the
        provider.
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {keys.map((key) => (
          <label key={key} className="block">
            <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-faint">{key.replace(/([A-Z])/g, ' $1')}</span>
            <Input
              inputMode="numeric"
              placeholder={current[key] !== null && current[key] !== undefined ? String(current[key]) : 'unknown'}
              value={draft[key] ?? ''}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value.replace(/[^0-9]/g, '') })}
            />
          </label>
        ))}
      </div>
      <label className="mt-2 block">
        <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-faint">reset strategy</span>
        <Select
          value={draft.resetStrategy ?? (current as Record<string, unknown>).resetStrategy?.toString() ?? 'unknown'}
          onChange={(event) => setDraft({ ...draft, resetStrategy: event.target.value })}
        >
          {['unknown', 'utc_midnight', 'provider_timezone', 'rolling_24h', 'explicit_timestamp', 'api_reported'].map((strategy) => (
            <option key={strategy} value={strategy}>
              {strategy.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="primary"
          loading={saving}
          onClick={() => {
            const limits: Record<string, number | null> = {};
            for (const key of keys) {
              const raw = draft[key];
              if (raw === undefined) continue;
              limits[key] = raw === '' ? null : Number.parseInt(raw, 10);
            }
            if (draft.resetStrategy) limits.resetStrategy = draft.resetStrategy as never;
            onSave(limits);
            setOpen(false);
          }}
        >
          Save limits for {providerId}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function priceLabel(pricing: ModelInfo['pricing']): ReactNode {
  if (pricing.inputPerMillionTokens === null && pricing.outputPerMillionTokens === null) {
    return (
      <span className="text-faint" title="The provider publishes no price for this model. FREE ONLY mode treats an unknown price as unusable, so this model is never selected there.">
        unknown
      </span>
    );
  }
  const format = (value: number | null): string => (value === 0 ? 'free' : value === null ? '?' : `$${value}`);
  return (
    <span title={`provenance: ${pricing.provenance}`}>
      {format(pricing.inputPerMillionTokens)} / {format(pricing.outputPerMillionTokens)}
    </span>
  );
}

