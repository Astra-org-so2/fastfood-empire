import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Checkbox, cx, ErrorState, formatBytes, formatPercent, Input, LoadingRows, Panel, Select } from '@aido/ui';
import type { AgentId, TaskType } from '@aido/types';
import { api, useAgents, useHealth, usePlatform, useRouterPolicy, useRouterPolicyMutation, useSettings, useSettingsMutation } from '../lib/api.js';
import { KeyValue, Mono, PageHeader, ProjectPicker, Section, TimeAgo, useProjectSelection } from '../components/common.js';

/**
 * Settings: policy, limits, security posture, the team roster and diagnostics.
 *
 * This screen is where the product explains itself. Three groups of controls exist —
 * routing policy, hard limits, security — and each one states the effect of a change
 * rather than just the field name. The diagnostics panel shows what the runtime can and
 * cannot do, including the update path and where credentials are stored.
 */
export function SettingsScreen(): ReactNode {
  const settings = useSettings();
  const platform = usePlatform();
  const policy = useRouterPolicy();
  const health = useHealth();
  const agents = useAgents();
  const [toast, setToast] = useState<string | null>(null);

  if (settings.isLoading) return <LoadingRows rows={8} />;
  if (settings.error) return <ErrorState title="Settings could not be loaded" detail={(settings.error as Error).message} retry={() => void settings.refetch()} />;
  const data = settings.data!;

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Settings"
        subtitle={`Applied immediately · shell: ${data.capabilities.shell.kind} · credentials: ${data.capabilities.secretSource === 'env' ? 'master key from the environment' : 'master key file'}`}
      />

      {toast ? (
        <div className="mb-3 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2 text-[12px] text-muted">
          {toast}
          <button type="button" className="ml-2 text-accent hover:underline" onClick={() => setToast(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <GeneralPanel onToast={setToast} />
        <LimitsPanel onToast={setToast} />
        <SecurityPanel onToast={setToast} />
        <RouterPolicyPanel />
        <TeamPanel />
        <DiagnosticsPanel diagnostics={{ platform: platform.data, health: health.data, counts: data.counts, capabilities: data.capabilities, agents: agents.data?.length ?? 0 }} onToast={setToast} />
        <NotificationPanel onToast={setToast} />
        <UpdatePanel onToast={setToast} />
        <QuotaPolicyPanel onToast={setToast} />
      </div>

      <p className="mt-3 text-[11px] text-faint">
        Settings are persisted in the project database next to the work they govern, and every change is recorded as an event so the activity log shows who changed which policy and when.
      </p>
      <p className="mt-1 text-[11px] text-faint">
        Router policy values marked <em>unverified</em> are the shipped defaults for provider metadata; they are editable, and anything learned from a live provider response replaces them.
      </p>
      {policy.data ? (
        <pre className="mt-2 max-h-64 scroll-y rounded bg-inset px-2 py-1.5 text-[10px] leading-4 text-muted">{JSON.stringify(policy.data.settings.weights, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function useSavable(onToast: (message: string) => void) {
  const mutation = useSettingsMutation();
  return async (patch: Parameters<typeof mutation.mutateAsync>[0], message: string): Promise<void> => {
    try {
      await mutation.mutateAsync(patch);
      onToast(message);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  };
}

function GeneralPanel({ onToast }: { onToast: (message: string) => void }): ReactNode {
  const settings = useSettings();
  const save = useSavable(onToast);
  const s = settings.data!.settings;

  return (
    <Section title="General">
      <div className="space-y-2 px-3 py-2.5">
        <label className="flex items-center justify-between gap-2 text-[12px]">
          <span>
            Execution mode
            <span className="block text-[11px] text-faint">
              <Mono>manual</Mono> plans only, <Mono>supervised</Mono> asks before risky actions, <Mono>auto</Mono> runs the whole loop unattended.
            </span>
          </span>
          <Select value={s.executionMode} onChange={(event) => void save({ executionMode: event.target.value as never }, `Execution mode set to ${event.target.value}.`)}>
            <option value="manual">manual</option>
            <option value="supervised">supervised</option>
            <option value="auto">auto</option>
          </Select>
        </label>

        <Checkbox
          label="FREE ONLY mode"
          hint="Never route to a paid model or a provider with unknown pricing, and never spend trial credits. Non-renewable free balances are excluded."
          checked={s.freeOnlyMode}
          onChange={(value) => void save({ freeOnlyMode: value }, value ? 'FREE ONLY mode enabled: only renewable free quota will be used.' : 'FREE ONLY mode disabled.')}
        />

        <label className="flex items-center justify-between gap-2 text-[12px]">
          <span>
            Dense tables
            <span className="block text-[11px] text-faint">Reduces row padding for long logs and wide tables.</span>
          </span>
          <input type="checkbox" checked={s.denseMode} onChange={(event) => void save({ denseMode: event.target.checked }, 'Display density updated.')} />
        </label>

        <label className="flex items-center justify-between gap-2 text-[12px]">
          <span>
            Telemetry retention
            <span className="block text-[11px] text-faint">Days of metrics and traces kept before pruning.</span>
          </span>
          <Input
            className="w-20"
            inputMode="numeric"
            defaultValue={s.telemetryRetentionDays}
            onBlur={(event) => void save({ telemetryRetentionDays: Number(event.target.value) || s.telemetryRetentionDays }, 'Telemetry retention updated.')}
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-[12px]">
          <span>
            Event retention
            <span className="block text-[11px] text-faint">Days of activity events kept.</span>
          </span>
          <Input
            className="w-20"
            inputMode="numeric"
            defaultValue={s.eventRetentionDays}
            onBlur={(event) => void save({ eventRetentionDays: Number(event.target.value) || s.eventRetentionDays }, 'Event retention updated.')}
          />
        </label>
      </div>
    </Section>
  );
}

function LimitsPanel({ onToast }: { onToast: (message: string) => void }): ReactNode {
  const settings = useSettings();
  const save = useSavable(onToast);
  const limits = settings.data!.settings.supervisor;

  const fields: { key: keyof typeof limits; label: string; hint: string }[] = [
    { key: 'maxRetriesPerTask', label: 'Max retries per task', hint: 'A task that fails more often than this is escalated instead of retried.' },
    { key: 'maxTokensPerTask', label: 'Max tokens per task', hint: 'Counts every model call the task makes, including retries.' },
    { key: 'maxTaskRuntimeMs', label: 'Max task runtime (ms)', hint: 'The sandbox and the model calls are both bounded by this.' },
    { key: 'maxAgentIterations', label: 'Max agent iterations', hint: 'Tool-call rounds per task. Stops an agent that keeps calling tools without converging.' },
    { key: 'maxParallelAgents', label: 'Max parallel agents', hint: 'How many tasks may be in flight at once across the project.' },
  ];

  return (
    <Section title="Hard limits">
      <div className="space-y-2 px-3 py-2.5">
        {fields.map((field) => (
          <label key={String(field.key)} className="flex items-start justify-between gap-3 text-[12px]">
            <span className="min-w-0">
              {field.label}
              <span className="block text-[11px] text-faint">{field.hint}</span>
            </span>
            <Input
              className="w-28"
              inputMode="numeric"
              defaultValue={String(limits[field.key] ?? '')}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value) || value <= 0) return;
                void save({ supervisor: { ...limits, [field.key]: value } }, `${field.label} set to ${value}.`);
              }}
            />
          </label>
        ))}
        <Checkbox
          label="Retry on a different model"
          hint="When a task fails for a model-specific reason, the retry uses a different model instead of the same one."
          checked={limits.retryWithDifferentModel}
          onChange={(value) => void save({ supervisor: { ...limits, retryWithDifferentModel: value } }, 'Retry policy updated.')}
        />
        <p className="text-[11px] text-faint">
          These limits are enforced by the supervisor, not requested from the model. Reaching one fails the task with a category the UI shows above.
        </p>
      </div>
    </Section>
  );
}

function SecurityPanel({ onToast }: { onToast: (message: string) => void }): ReactNode {
  const settings = useSettings();
  const save = useSavable(onToast);
  const security = settings.data!.settings.security;

  return (
    <Section title="Security">
      <div className="space-y-2 px-3 py-2.5">
        <Checkbox
          label="Encrypt credentials at rest"
          hint="AES-256-GCM with a per-install master key. Turning this off stores keys in the database unencrypted — not recommended."
          checked={security.encryptCredentials}
          onChange={(value) => void save({ security: { ...security, encryptCredentials: value } }, value ? 'Credential encryption enabled.' : 'Credential encryption disabled.')}
        />
        <Checkbox
          label="Redact secrets from logs"
          hint="Scrubs anything shaped like an API key before it reaches a log line or an event payload."
          checked={security.redactLogs}
          onChange={(value) => void save({ security: { ...security, redactLogs: value } }, 'Log redaction updated.')}
        />
        <Checkbox
          label="Prompt-injection defence"
          hint="Repository content, files written by other agents and fetched pages are treated as untrusted data and may never change the instructions an agent follows."
          checked={security.promptInjectionDefense}
          onChange={(value) => void save({ security: { ...security, promptInjectionDefense: value } }, 'Prompt-injection defence updated.')}
        />
        <Checkbox
          label="Always confirm destructive operations"
          hint="File deletion, force pushes, history rewrites and destructive shell commands wait for your approval even in auto mode."
          checked={security.alwaysConfirmDestructive}
          onChange={(value) => void save({ security: { ...security, alwaysConfirmDestructive: value } }, 'Approval policy updated.')}
        />
        <Checkbox
          label="Send repository content to providers"
          hint="Off by default. When off, agents work with file listings, diffs and their own summaries instead of full file bodies."
          checked={security.allowRepoContentToProviders}
          onChange={(value) => void save({ security: { ...security, allowRepoContentToProviders: value } }, value ? 'Repository content may be sent to providers.' : 'Repository content is no longer sent in full.')}
        />
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Never read these files</div>
          <div className="flex flex-wrap gap-1">
            {security.secretFileGlobs.map((glob) => (
              <span key={glob} className="rounded bg-inset px-1.5 py-0.5 text-[10px] text-muted">
                {glob}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-faint">Matched files are refused by the sandbox for every agent, including read-only roles.</p>
        </div>
      </div>
    </Section>
  );
}

function RouterPolicyPanel(): ReactNode {
  const settings = useSettings();
  const policy = useRouterPolicy();
  const mutation = useRouterPolicyMutation();

  if (!policy.data) return <Section title="Router policy">{policy.isLoading ? <LoadingRows rows={4} /> : <div className="px-3 py-3 text-[12px] text-muted">Policy unavailable.</div>}</Section>;
  const weights = policy.data.settings.weights as Record<string, number>;

  return (
    <Section title="Router policy" className="lg:col-span-2">
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-[11px] text-muted">
          A model's score is the weighted sum below. Every component is recorded on the model call's trace, so the dashboard can always answer "why this model?". Weights apply to all task types;
          per-task-type preferences follow their own policies.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          {Object.entries(weights).map(([key, value]) => (
            <label key={key} className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-muted">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
              <span className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={value}
                  className="w-32 accent-[var(--color-accent)]"
                  onChange={(event) => {
                    const next = { ...weights, [key]: Number(event.target.value) };
                    void mutation.mutateAsync({ weights: next });
                  }}
                />
                <span className="tabular w-10 text-right">{value.toFixed(2)}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <Checkbox
            label="Learn task-type preferences from history"
            hint="After enough attempts, the router prefers the model that actually succeeded at this kind of task rather than the one with the best declared capabilities."
            checked={policy.data.settings.learningEnabled}
            onChange={(value) => void mutation.mutateAsync({ learningEnabled: value })}
          />
          <Checkbox
            label="Spread load across providers"
            hint="Prefers a provider with fewer recent requests, which keeps several free tiers usable at once instead of exhausting one."
            checked={policy.data.settings.spreadAcrossProviders}
            onChange={(value) => void mutation.mutateAsync({ spreadAcrossProviders: value })}
          />
          <Checkbox
            label="Allow trial credits"
            hint="Off by default: trial credits are finite, and using them can end the free period early. FREE ONLY mode always excludes them."
            checked={policy.data.settings.allowTrialCredits}
            onChange={(value) => void mutation.mutateAsync({ allowTrialCredits: value })}
          />
          <Checkbox
            label="Refuse unknown pricing"
            hint="A model whose price the provider does not publish is never selected when this is on — unknown cost is not treated as free."
            checked={policy.data.settings.blockUnknownPricing}
            onChange={(value) => void mutation.mutateAsync({ blockUnknownPricing: value })}
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-muted">
            Keep this fraction of each window unused
            <span className="block text-[11px] text-faint">A safety margin so an in-flight batch cannot overrun a limit mid-run.</span>
          </span>
          <span className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={0.5}
              step={0.05}
              value={policy.data.settings.quotaReserveFloor}
              className="w-32 accent-[var(--color-accent)]"
              onChange={(event) => void mutation.mutateAsync({ quotaReserveFloor: Number(event.target.value) })}
            />
            <span className="tabular w-12 text-right">{formatPercent(policy.data.settings.quotaReserveFloor)}</span>
          </span>
        </div>

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Task-type policies</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Task type</th>
                <th>Preferred capabilities</th>
                <th>Priority</th>
                <th>Quality floor</th>
              </tr>
            </thead>
            <tbody>
              {policy.data.policies.map((entry) => (
                <tr key={entry.taskType} className="row-hover">
                  <td>{entry.taskType.replace(/_/g, ' ')}</td>
                  <td className="text-muted">{(entry.preferredCapabilities ?? []).join(', ') || '—'}</td>
                  <td>
                    <Badge tone={entry.priority === 'critical' ? 'danger' : entry.priority === 'high' ? 'warn' : 'neutral'}>{String(entry.priority ?? 'normal')}</Badge>
                  </td>
                  <td className="tabular">{entry.qualityFloor !== undefined ? entry.qualityFloor.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <PreviewTool taskTypes={policy.data.taskTypes} />
        <p className="text-[11px] text-faint">
          Execution mode is currently <Mono>{settings.data?.settings.executionMode}</Mono>; per-project settings can override it.
        </p>
      </div>
    </Section>
  );
}

/** "Why would you pick that model?" — answered for a hypothetical task, before any run. */
function PreviewTool({ taskTypes }: { taskTypes: TaskType[] }): ReactNode {
  const [taskType, setTaskType] = useState<TaskType>(taskTypes[0] ?? 'code_generation');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 p-2">
      <div className="mb-1 text-[11px] text-muted">Preview a routing decision without running anything.</div>
      <div className="flex items-center gap-2">
        <Select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)}>
          {taskTypes.map((entry) => (
            <option key={entry} value={entry}>
              {entry.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const preview = await api.routerPreview({ taskType });
              if (!preview.selected) {
                setResult(
                  `No model is eligible for ${taskType.replace(/_/g, ' ')}: ${preview.chain.length} candidate(s) considered, all rejected. ${
                    preview.chain[0]?.negatives?.[0] ?? 'See the model list for enabled and free-only status.'
                  }`,
                );
              } else {
                const top = preview.chain.find((entry) => entry.modelId === preview.selected?.model.id);
                setResult(
                  `${preview.selected.model.displayName} (${preview.selected.model.id}) — score ${preview.rationale?.totalScore?.toFixed(3) ?? top?.total.toFixed(3) ?? 'n/a'}` +
                    `${preview.rationale?.freeOnlyApplied ? ' · FREE ONLY applied' : ''}. ` +
                    `${preview.rationale?.positives?.slice(0, 3).join('; ') ?? 'no positives recorded'}` +
                    `${preview.chain.length > 1 ? ` · ${preview.chain.length - 1} other candidate(s) scored lower` : ''}`,
                );
              }
            } catch (err) {
              setResult(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Preview
        </Button>
      </div>
      {result ? <div className="mt-1.5 text-[11px] text-muted">{result}</div> : null}
    </div>
  );
}

function TeamPanel(): ReactNode {
  const [projectId, setProjectId, projects] = useProjectSelection();
  const agents = useAgents(projectId ?? undefined);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const list = agents.data ?? [];
  const enabled = list.filter((agent) => !agent.state?.paused);

  return (
    <Section title="Team">
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted">
            {projects.isEmpty ? (
              'Team enablement is stored per project: create a project to enable or pause roles.'
            ) : (
              <>
                {enabled.length} of {list.length} roles are active in this project. Pausing a role removes it from dispatch; its queued tasks stay queued until it resumes or the supervisor reassigns them.
              </>
            )}
          </p>
          <ProjectPicker value={projectId} onChange={setProjectId} />
        </div>
        <div className="space-y-1">
          {list.map((agent) => (
            <label key={agent.id} className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={!agent.state?.paused}
                disabled={agent.id === 'supervisor' || busy || !projectId}
                onChange={async (event) => {
                  if (!projectId) return;
                  setBusy(true);
                  try {
                    if (event.target.checked) await api.resumeAgent(agent.id as AgentId, projectId);
                    else await api.pauseAgent(agent.id as AgentId, projectId);
                    await agents.refetch();
                  } catch (err) {
                    setToast(err instanceof Error ? err.message : String(err));
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              {agent.id === 'supervisor' ? <Badge tone="accent">always on</Badge> : null}
              <span className="text-[10px] text-faint">{(agent.handledTaskTypes ?? []).length} task types</span>
            </label>
          ))}
        </div>
        {toast ? <div className="text-[11px] text-danger">{toast}</div> : null}
      </div>
    </Section>
  );
}

function NotificationPanel({ onToast }: { onToast: (message: string) => void }): ReactNode {
  const settings = useSettings();
  const save = useSavable(onToast);
  const platform = usePlatform();
  const notifications = settings.data!.settings.notifications;
  const supported = platform.data?.notifications.supported ?? false;

  return (
    <Section title="Notifications">
      <div className="space-y-2 px-3 py-2.5">
        <div className={cx('rounded-[var(--radius-sm)] border px-2 py-1.5 text-[11px]', supported ? 'border-free/40 bg-free/5 text-free' : 'border-warn/40 bg-warn/5 text-warn')}>
          {supported
            ? 'Desktop notifications are available in this environment.'
            : 'System notifications are not available here (no notification daemon was found). The in-app activity feed still records every event.'}
        </div>
        <Checkbox label="Approvals" hint="Tell me when an agent is blocked waiting for a decision." checked={notifications.approvals} onChange={(value) => void save({ notifications: { ...notifications, approvals: value } }, 'Notification preference saved.')} />
        <Checkbox label="Failures" hint="Tell me when a run fails." checked={notifications.failures} onChange={(value) => void save({ notifications: { ...notifications, failures: value } }, 'Notification preference saved.')} />
        <Checkbox label="Quota events" hint="Tell me when a free tier is exhausted." checked={notifications.quota} onChange={(value) => void save({ notifications: { ...notifications, quota: value } }, 'Notification preference saved.')} />
        <Button
          onClick={async () => {
            try {
              const result = await api.notificationTest();
              onToast(result.delivered ? 'Test notification delivered.' : `Not delivered: ${result.reason ?? 'unknown reason'}`);
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Send a test notification
        </Button>
      </div>
    </Section>
  );
}

function UpdatePanel({ onToast }: { onToast: (message: string) => void }): ReactNode {
  const platform = usePlatform();
  const [result, setResult] = useState<{ status: string; instructions: string; latestVersion?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Section title="Updates">
      <div className="space-y-2 px-3 py-2.5">
        <KeyValue
          columns={1}
          items={[
            { label: 'Installed version', value: <Mono>{platform.data?.updates.currentVersion ?? '—'}</Mono> },
            { label: 'Update feed', value: platform.data?.updates.feedUrl ? <Mono className="break-all">{platform.data.updates.feedUrl}</Mono> : <span className="text-faint">not configured (AIDO_UPDATE_FEED)</span> },
            { label: 'Channel', value: platform.data?.app.channel ?? '—' },
          ]}
        />
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setResult(await api.updateCheck());
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Check for updates
        </Button>
        {result ? (
          <div className="rounded-[var(--radius-sm)] border border-line bg-surface-2 px-2 py-1.5 text-[11px]">
            <div className="flex items-center gap-2">
              <Badge tone={result.status === 'up-to-date' ? 'free' : result.status === 'update-available' ? 'accent' : 'warn'}>{result.status}</Badge>
              {result.latestVersion ? <Mono>{result.latestVersion}</Mono> : null}
            </div>
            <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted">{result.instructions}</pre>
            {result.error ? <div className="text-danger">{result.error}</div> : null}
          </div>
        ) : null}
        <p className="text-[11px] text-faint">
          Updates are never installed silently: the desktop package needs privileges this application does not take on its own. The command above is what to run, or replace the AppImage.
        </p>
      </div>
    </Section>
  );
}

function QuotaPolicyPanel({ onToast }: { onToast: (message: string) => void }): ReactNode {
  const settings = useSettings();
  const save = useSavable(onToast);
  const quota = settings.data!.settings.quota;

  return (
    <Section title="Quota accounting">
      <div className="space-y-2 px-3 py-2.5">
        <Checkbox
          label="Learn limits from provider responses"
          hint="Reads remaining-quota headers and usage endpoints after each request. Live values always override the shipped defaults."
          checked={quota.learnFromHeaders}
          onChange={(value) => void save({ quota: { ...quota, learnFromHeaders: value } }, 'Quota learning updated.')}
        />
        <Checkbox
          label="Treat unknown limits as unlimited"
          hint="Dangerous. Off by default: a provider whose limits are unknown is reported as unknown and refuses reservation, so the orchestrator cannot accidentally spend unknown quota."
          checked={quota.assumeUnknownIsUnlimited}
          onChange={(value) => void save({ quota: { ...quota, assumeUnknownIsUnlimited: value } }, value ? 'Unknown limits are now treated as unlimited.' : 'Unknown limits now block reservation.')}
        />
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-muted">
            Reservation TTL (ms)
            <span className="block text-[11px] text-faint">How long a reservation is held before it is reclaimed if the call never reports back.</span>
          </span>
          <Input
            className="w-28"
            inputMode="numeric"
            defaultValue={quota.reservationTtlMs}
            onBlur={(event) => void save({ quota: { ...quota, reservationTtlMs: Number(event.target.value) || quota.reservationTtlMs } }, 'Reservation TTL updated.')}
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-muted">
            Cooldown after a rate limit (ms)
            <span className="block text-[11px] text-faint">Multiplied on repeated limits, up to the maximum below.</span>
          </span>
          <Input
            className="w-28"
            inputMode="numeric"
            defaultValue={quota.defaultCooldownMs}
            onBlur={(event) => void save({ quota: { ...quota, defaultCooldownMs: Number(event.target.value) || quota.defaultCooldownMs } }, 'Cooldown updated.')}
          />
        </div>
        <p className="text-[11px] text-faint">
          Reserving quota is atomic: two agents cannot both reserve the last request in a window, and a reservation that is not settled is expired rather than leaked.
        </p>
      </div>
    </Section>
  );
}

function DiagnosticsPanel({
  diagnostics,
  onToast,
}: {
  diagnostics: {
    platform: Awaited<ReturnType<typeof api.platform>> | undefined;
    health: Awaited<ReturnType<typeof api.health>> | undefined;
    counts: { projects: number; providers: number; models: number; agents: number; openReservations: number; databaseBytes: number };
    capabilities: { shell: { kind: string; platform: string; isDesktop: boolean }; secretSource: string; maxParallelAgents: number; adapterKinds: string[] };
    agents: number;
  };
  onToast: (message: string) => void;
}): ReactNode {
  const streamState = useStreamState();

  return (
    <Section title="Diagnostics" className="lg:col-span-2">
      <div className="grid gap-3 px-3 py-2.5 md:grid-cols-2">
        <KeyValue
          columns={1}
          items={[
            { label: 'Shell', value: `${diagnostics.capabilities.shell.kind} on ${diagnostics.capabilities.shell.platform}` },
            { label: 'API version', value: <Mono>{diagnostics.health?.version ?? '—'}</Mono> },
            { label: 'Uptime', value: diagnostics.health ? `${Math.round(diagnostics.health.uptimeSeconds / 60)} min` : '—' },
            { label: 'Database', value: diagnostics.platform ? <Mono className="break-all">{diagnostics.platform.paths.databaseFile}</Mono> : '—' },
            { label: 'Database size', value: formatBytes(diagnostics.counts.databaseBytes) },
            { label: 'Schema version', value: diagnostics.health?.database.migrations.version ?? '—' },
            { label: 'Live event stream', value: <Badge tone={streamState === 'open' ? 'free' : 'warn'}>{streamState}</Badge> },
          ]}
        />
        <KeyValue
          columns={1}
          items={[
            { label: 'Projects', value: diagnostics.counts.projects },
            { label: 'Providers', value: `${diagnostics.counts.providers} definitions, ${diagnostics.capabilities.adapterKinds.length} adapter kinds` },
            { label: 'Models', value: diagnostics.counts.models },
            { label: 'Agent roles', value: `${diagnostics.counts.agents} enabled of ${diagnostics.counts.agents}` },
            { label: 'Open reservations', value: diagnostics.counts.openReservations },
            { label: 'Credential storage', value: diagnostics.capabilities.secretSource === 'env' ? 'master key from environment' : diagnostics.platform?.secrets.credentialVault.keyFile ?? 'master key file' },
            { label: 'Shell secret store', value: diagnostics.platform ? `${diagnostics.platform.secrets.shellStore.kind} — ${diagnostics.platform.secrets.shellStore.detail}` : '—' },
          ]}
        />
      </div>

      {diagnostics.health?.degraded.length ? (
        <div className="border-t border-line px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-faint">Degraded subsystems</div>
          <ul className="space-y-0.5 text-[11px] text-warn">
            {diagnostics.health.degraded.map((entry, index) => (
              <li key={index}>
                {entry.component}: {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        <Button
          onClick={async () => {
            try {
              const result = await api.reloadCatalog();
              onToast(`Provider catalog reloaded: ${result.count} definitions, ${result.issues.length} issue(s).`);
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Reload provider catalog
        </Button>
        <Button
          onClick={async () => {
            try {
              const result = await api.systemAction('events.purge');
              onToast(`${result.deleted ?? 0} event(s) older than the retention window were removed.`);
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Purge old events
        </Button>
        <Button
          onClick={async () => {
            try {
              const result = await api.systemAction('traces.purge');
              onToast(`${result.deleted ?? 0} model-call trace(s) removed.`);
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Purge old traces
        </Button>
        <Button
          onClick={async () => {
            try {
              const result = await api.systemAction('quota.release_expired');
              onToast(`${result.released ?? 0} expired reservation(s) released.`);
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Expire stale reservations
        </Button>
        <Button
          onClick={async () => {
            try {
              const result = await api.systemAction('providers.health_check_all');
              onToast(`Health checked ${result.providers?.length ?? 0} provider(s).`);
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Health-check every provider
        </Button>
      </div>
    </Section>
  );
}

/** Reads the SSE connection state without opening a second stream. */
function useStreamState(): 'connecting' | 'open' | 'closed' {
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  useEffect(() => {
    // A cheap liveness probe stands in for the stream state: the header owns the real
    // stream, and opening another EventSource per screen would multiply connections.
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        await api.health();
        if (!cancelled) setState('open');
      } catch {
        if (!cancelled) setState('closed');
      }
    };
    void check();
    const timer = setInterval(check, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}

