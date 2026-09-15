import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleSlash, KeyRound, RefreshCw, ShieldQuestion } from 'lucide-react';
import { Badge, Button, cx, EmptyState, ErrorState, formatNumber, LoadingRows, Modal, QuotaTypeBadge, Panel, StatusDot } from '@aido/ui';
import type { ProviderSummary } from '@aido/providers';
import { useProvider, useProviderActions, useProviders, api } from '../lib/api.js';
import { credentialLabel, healthTone, PageHeader } from '../components/common.js';
import { CredentialForm, credentialFieldsOf } from './ProviderDetail.js';

/**
 * Providers (§8, §38).
 *
 * The list is designed to answer three questions without opening anything: can I use
 * this provider, is it free, and does it work right now. Credentials are never shown —
 * only whether they exist, when they were last checked, and how many fields are missing.
 */
export function Providers(): ReactNode {
  const providers = useProviders();
  const actions = useProviderActions(undefined);
  const [keyTarget, setKeyTarget] = useState<ProviderSummary | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const list = providers.data?.providers ?? [];
  const configured = list.filter((provider) => provider.credentialStatus.state === 'valid').length;

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Providers"
        subtitle={`${list.length} provider definitions · ${configured} with credentials · ${list.filter((provider) => provider.enabled).length} enabled`}
        actions={
          <>
            <Button
              icon={<RefreshCw className="size-3.5" />}
              loading={actions.discover.isPending}
              onClick={async () => {
                setBusy('all');
                try {
                  const result = await api.discoverAllModels();
                  const added = result.providers.reduce((sum, entry) => sum + entry.added, 0);
                  const updated = result.providers.reduce((sum, entry) => sum + entry.updated, 0);
                  const failed = result.providers.filter((entry) => entry.error);
                  setToast(
                    `Discovery: ${added} new model${added === 1 ? '' : 's'}, ${updated} updated.` +
                      (failed.length ? ` ${failed.length} provider(s) could not be queried: ${failed.map((entry) => `${entry.providerId} (${entry.error})`).join('; ')}` : ''),
                  );
                } catch (err) {
                  setToast(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(null);
                  await providers.refetch();
                }
              }}
            >
              Discover models
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  const result = await api.reloadCatalog();
                  setToast(`Catalog reloaded: ${result.count} definitions${result.issues.length ? `, ${result.issues.length} issue(s)` : ''}.`);
                  await providers.refetch();
                } catch (err) {
                  setToast(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Reload catalog
            </Button>
          </>
        }
      />

      {toast ? (
        <div className="mb-3 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted">
          {toast}
          <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setToast(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      {providers.isLoading ? <LoadingRows rows={8} /> : null}
      {providers.error ? <ErrorState title="Providers could not be loaded" detail={(providers.error as Error).message} retry={() => void providers.refetch()} /> : null}

      {providers.data && list.length === 0 ? <EmptyState title="No provider definitions" detail="Provider definitions live in config/providers/*.json. Adding one requires only a JSON file plus an adapter for its API shape." /> : null}

      <div className="grid gap-2 xl:grid-cols-2">
        {list.map((provider) => {
          const credentials = credentialLabel(provider.credentialStatus.state);
          const needsKey = provider.credentialStatus.state !== 'valid';
          return (
            <Panel key={provider.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 border-b border-line px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/providers/${provider.id}`} className="text-[13px] font-medium text-ink hover:text-accent">
                      {provider.name}
                    </Link>
                    <QuotaTypeBadge type={provider.freeTier?.quotaType ?? null} />
                    {provider.simulated ? <Badge tone="hosted">simulated</Badge> : null}
                    {!provider.enabled ? <Badge tone="unknown">disabled</Badge> : null}
                    {provider.metadataVerified ? null : (
                      <Badge tone="warn" title="Model and quota metadata for this provider has not been verified against the provider's current documentation. Limits are editable and any value learned from live responses takes precedence.">
                        unverified metadata
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted">{provider.notes || 'no notes'}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="flex items-center gap-1 text-[11px]">
                    <StatusDot tone={healthTone(provider.health.status)} />
                    {provider.health.status}
                  </span>
                </div>
              </div>

              <div className="flex-1 px-3 py-2">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] md:grid-cols-4">
                  <Field label="Class" value={<QuotaTypeBadge type={provider.freeTier?.quotaType ?? null} />} />
                  <Field
                    label="Reset"
                    value={
                      provider.freeTier?.resetStrategy ? (
                        <span title={provider.freeTier.note ?? undefined}>
                          {provider.freeTier.resetStrategy.replace(/_/g, ' ')}
                          {provider.freeTier.resetTimezone ? ` (${provider.freeTier.resetTimezone})` : ''}
                        </span>
                      ) : (
                        <span className="text-faint">unknown</span>
                      )
                    }
                  />
                  <Field label="Models" value={`${provider.modelCount} (${provider.freeModelCount} free)`} />
                  <Field label="Adapter" value={provider.adapter.registered ? provider.adapter.name : <span className="text-warn">not registered</span>} />
                </div>

                <div className="mt-2 flex items-start gap-2 rounded-[var(--radius-sm)] border border-line bg-surface-2 px-2 py-1.5 text-[11px]">
                  {provider.credentialStatus.state === 'valid' ? (
                    <>
                      <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-free" />
                      <span className="text-muted">
                        Credentials stored and encrypted. {provider.credentialDisplay ? <>Last four visible: <span className="tabular">{provider.credentialDisplay}</span>.</> : null} The full key is never
                        shown or logged again.
                      </span>
                    </>
                  ) : provider.credentialStatus.state === 'invalid' ? (
                    <>
                      <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-danger" />
                      <span className="text-danger">
                        The stored credential was rejected by the provider{provider.credentialStatus.detail ? `: ${provider.credentialStatus.detail}` : ''}. Replace it to use this provider.
                      </span>
                    </>
                  ) : (
                    <>
                      <ShieldQuestion className="mt-0.5 size-3.5 shrink-0 text-warn" />
                      <span className="text-muted">
                        Credentials: {credentials.label}. Missing: {(provider.missingCredentialFields ?? []).join(', ') || 'not established'}.
                        {!provider.enabled ? ' This provider is also disabled.' : ''}
                      </span>
                    </>
                  )}
                </div>

                {provider.health.message ? <div className="mt-1 text-[11px] text-faint">Last health check: {provider.health.message}</div> : null}
                {provider.lastError ? <div className="mt-1 text-[11px] text-danger">{provider.lastError}</div> : null}
                {provider.cooldownUntil ? <div className="mt-1 text-[11px] text-warn">In cooldown until {provider.cooldownUntil} — the router will skip it.</div> : null}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
                <Button icon={<KeyRound className="size-3.5" />} onClick={() => setKeyTarget(provider)}>
                  {needsKey ? 'Add key' : 'Replace key'}
                </Button>
                <Button
                  loading={busy === `test-${provider.id}`}
                  onClick={async () => {
                    setBusy(`test-${provider.id}`);
                    try {
                      const result = await api.testProvider(provider.id);
                      setToast(`${provider.name}: ${result.detail}`);
                    } catch (err) {
                      setToast(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                      setBusy(null);
                      await providers.refetch();
                    }
                  }}
                >
                  Test
                </Button>
                <Button
                  loading={busy === `discover-${provider.id}`}
                  onClick={async () => {
                    setBusy(`discover-${provider.id}`);
                    try {
                      const result = await api.discoverModels(provider.id);
                      setToast(
                        result.error
                          ? `${provider.name}: discovery failed — ${result.error}`
                          : `${provider.name}: ${result.added} added, ${result.updated} updated.`,
                      );
                    } finally {
                      setBusy(null);
                      await providers.refetch();
                    }
                  }}
                >
                  Discover
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.patchProvider(provider.id, { enabled: !provider.enabled });
                      await providers.refetch();
                    } catch (err) {
                      setToast(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  {provider.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Link to={`/providers/${provider.id}`} className="ml-auto text-[11px] text-accent hover:underline">
                  detail →
                </Link>
              </div>
            </Panel>
          );
        })}
      </div>

      <p className="mt-3 text-[11px] text-faint">
        Quota figures are only as good as their source. Anything published by a provider is stored as unverified data, and any limit learned from a live response header or usage endpoint
        takes precedence over it. A provider whose limits are unknown is reported as unknown — never assumed to be unlimited.
      </p>

      <Modal open={Boolean(keyTarget)} title={keyTarget ? `Credentials for ${keyTarget.name}` : ''} onClose={() => setKeyTarget(null)}>
        {keyTarget ? (
          <CredentialFormLoader
            providerId={keyTarget.id}
            providerName={keyTarget.name}
            onDone={async (message) => {
              setToast(message);
              setKeyTarget(null);
              await providers.refetch();
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}

/**
 * Loads the provider's definition before offering its credential form: the field list
 * (and which of them are required) comes from the provider definition, and guessing it
 * would produce a form that cannot work for providers with extra fields.
 */
function CredentialFormLoader({ providerId, providerName, onDone }: { providerId: string; providerName: string; onDone: (message: string) => void }): ReactNode {
  const provider = useProvider(providerId);
  if (provider.isLoading) return <LoadingRows rows={2} />;
  if (!provider.data) return <div className="text-[12px] text-muted">Could not load this provider's definition.</div>;
  return <CredentialForm providerId={providerId} providerName={providerName} fields={credentialFieldsOf(provider.data)} onDone={onDone} />;
}

function Field({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className="truncate text-ink">{value}</div>
    </div>
  );
}

