import type {
  AuthenticationType,
  CredentialStatus,
  ModelCapabilities,
  ModelInfo,
  ModelPerformance,
  ModelPricing,
  ModelQuotaLimits,
  ModelStatus,
  ProviderDefinition,
  ProviderHealth,
  ProviderHealthStatus,
  ProviderKind,
  QuotaType,
  ResetStrategy,
  TaskType,
} from '@aido/types';
import type { Database, Row } from '../db.js';
import type { CredentialRecord, CredentialStore } from '@aido/security';
import { fromBool, nowIso, parseJson, toBool, toNumber } from './helpers.js';

/**
 * Providers + credentials + model catalogue persistence.
 *
 * The provider *definition* is stored as JSON (it is data, versioned in config and
 * overridable from the UI), while the fields the dashboard filters and sorts on
 * are promoted to columns.
 */

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  apiBaseUrl: string;
  quotaType: QuotaType;
  resetStrategy: ResetStrategy;
  resetTimezone: string | null;
  definition: ProviderDefinition;
  quotaLimits: Omit<ModelQuotaLimits, 'provenance'> | null;
  health: ProviderHealth;
  lastError: string | null;
  lastErrorAt: string | null;
  cooldownUntil: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderRepository {
  list(): ProviderRecord[];
  get(id: string): ProviderRecord | null;
  upsertFromDefinition(definition: ProviderDefinition, options?: { enabled?: boolean }): ProviderRecord;
  setEnabled(id: string, enabled: boolean): void;
  updateRuntime(
    id: string,
    patch: {
      healthStatus?: ProviderHealthStatus;
      healthLatencyMs?: number | null;
      healthMessage?: string | null;
      consecutiveFailures?: number;
      lastError?: string | null;
      cooldownUntil?: string | null;
      lastSyncAt?: string;
    },
  ): void;
  saveOverride(id: string, patch: { apiBaseUrl?: string; quotaType?: QuotaType; resetStrategy?: ResetStrategy; resetTimezone?: string | null; quotaLimits?: Omit<ModelQuotaLimits, 'provenance'> | null; notes?: string }): void;
  delete(id: string): boolean;
}

export function createProviderRepository(db: Database): ProviderRepository {
  const map = (row: Row): ProviderRecord => ({
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind) as ProviderKind,
    enabled: toBool(row.enabled),
    apiBaseUrl: String(row.api_base_url),
    quotaType: String(row.quota_type) as QuotaType,
    resetStrategy: String(row.reset_strategy) as ResetStrategy,
    resetTimezone: row.reset_timezone === null ? null : String(row.reset_timezone),
    definition: parseJson<ProviderDefinition>(row.definition, {} as ProviderDefinition),
    quotaLimits: parseJson<Omit<ModelQuotaLimits, 'provenance'> | null>(row.quota_limits, null),
    health: {
      providerId: String(row.id),
      status: String(row.health_status) as ProviderHealthStatus,
      checkedAt: row.health_checked_at ? String(row.health_checked_at) : '',
      latencyMs: toNumber(row.health_latency_ms),
      message: row.health_message === null ? null : String(row.health_message),
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
    },
    lastError: row.last_error === null ? null : String(row.last_error),
    lastErrorAt: row.last_error_at === null ? null : String(row.last_error_at),
    cooldownUntil: row.cooldown_until === null ? null : String(row.cooldown_until),
    lastSyncAt: row.last_sync_at === null ? null : String(row.last_sync_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });

  return {
    list() {
      return db.all<Row>('SELECT * FROM providers ORDER BY name').map(map);
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM providers WHERE id = ?', [id]);
      return row ? map(row) : null;
    },
    upsertFromDefinition(definition, options = {}) {
      const existing = this.get(definition.id);
      const now = nowIso();
      // Preserve runtime state (health, cooldown) across restarts; only refresh the
      // definition mirror. An enabled flag set by the operator is never clobbered.
      const enabled = options.enabled ?? existing?.enabled ?? false;
      const record: ProviderRecord = {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        enabled,
        apiBaseUrl: definition.apiBaseUrl,
        quotaType: definition.freeTier.quotaType,
        resetStrategy: definition.freeTier.resetStrategy,
        resetTimezone: definition.freeTier.resetTimezone,
        definition,
        quotaLimits: definition.quotaLimits,
        health: existing?.health ?? {
          providerId: definition.id,
          status: 'unconfigured',
          checkedAt: '',
          latencyMs: null,
          message: null,
          consecutiveFailures: 0,
        },
        lastError: existing?.lastError ?? null,
        lastErrorAt: existing?.lastErrorAt ?? null,
        cooldownUntil: existing?.cooldownUntil ?? null,
        lastSyncAt: existing?.lastSyncAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      db.run(
        `INSERT INTO providers (id, name, kind, enabled, api_base_url, quota_type, reset_strategy, reset_timezone, definition, quota_limits,
           health_status, health_checked_at, health_latency_ms, health_message, consecutive_failures, last_error, last_error_at, cooldown_until, last_sync_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, api_base_url = excluded.api_base_url,
           quota_type = excluded.quota_type, reset_strategy = excluded.reset_strategy, reset_timezone = excluded.reset_timezone,
           definition = excluded.definition, quota_limits = excluded.quota_limits,
           enabled = excluded.enabled, updated_at = excluded.updated_at`,
        [
          record.id,
          record.name,
          record.kind,
          fromBool(record.enabled),
          record.apiBaseUrl,
          record.quotaType,
          record.resetStrategy,
          record.resetTimezone,
          JSON.stringify(record.definition),
          record.quotaLimits ? JSON.stringify(record.quotaLimits) : null,
          record.health.status,
          record.health.checkedAt || null,
          record.health.latencyMs,
          record.health.message,
          record.health.consecutiveFailures,
          record.lastError,
          record.lastErrorAt,
          record.cooldownUntil,
          record.lastSyncAt,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return record;
    },
    setEnabled(id, enabled) {
      db.run('UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?', [fromBool(enabled), nowIso(), id]);
    },
    updateRuntime(id, patch) {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso()];
      if (patch.healthStatus !== undefined) {
        sets.push('health_status = ?');
        params.push(patch.healthStatus);
      }
      if (patch.healthLatencyMs !== undefined) {
        sets.push('health_latency_ms = ?');
        params.push(patch.healthLatencyMs);
      }
      if (patch.healthMessage !== undefined) {
        sets.push('health_message = ?');
        params.push(patch.healthMessage);
      }
      if (patch.consecutiveFailures !== undefined) {
        sets.push('consecutive_failures = ?');
        params.push(patch.consecutiveFailures);
      }
      if (patch.lastError !== undefined) {
        sets.push('last_error = ?', 'last_error_at = ?');
        params.push(patch.lastError, nowIso());
      }
      if (patch.cooldownUntil !== undefined) {
        sets.push('cooldown_until = ?');
        params.push(patch.cooldownUntil);
      }
      if (patch.lastSyncAt !== undefined) {
        sets.push('last_sync_at = ?');
        params.push(patch.lastSyncAt);
      }
      if (patch.healthStatus !== undefined) {
        sets.push('health_checked_at = ?');
        params.push(nowIso());
      }
      params.push(id);
      db.run(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`, params);
    },
    saveOverride(id, patch) {
      const existing = this.get(id);
      if (!existing) return;
      const definition: ProviderDefinition = {
        ...existing.definition,
        apiBaseUrl: patch.apiBaseUrl ?? existing.definition.apiBaseUrl,
        notes: patch.notes ?? existing.definition.notes,
        freeTier: {
          ...existing.definition.freeTier,
          quotaType: patch.quotaType ?? existing.definition.freeTier.quotaType,
          resetStrategy: patch.resetStrategy ?? existing.definition.freeTier.resetStrategy,
          resetTimezone: patch.resetTimezone === undefined ? existing.definition.freeTier.resetTimezone : patch.resetTimezone,
        },
        quotaLimits: patch.quotaLimits === undefined ? existing.definition.quotaLimits : patch.quotaLimits,
      };
      db.run(
        `UPDATE providers SET api_base_url = ?, quota_type = ?, reset_strategy = ?, reset_timezone = ?, definition = ?,
           quota_limits = ?, updated_at = ? WHERE id = ?`,
        [
          definition.apiBaseUrl,
          definition.freeTier.quotaType,
          definition.freeTier.resetStrategy,
          definition.freeTier.resetTimezone,
          JSON.stringify(definition),
          definition.quotaLimits ? JSON.stringify(definition.quotaLimits) : null,
          nowIso(),
          id,
        ],
      );
    },
    delete(id) {
      return db.run('DELETE FROM providers WHERE id = ?', [id]).changes > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function createCredentialStore(db: Database): CredentialStore {
  const map = (row: Row): CredentialRecord => ({
    providerId: String(row.provider_id),
    field: String(row.field),
    encrypted: parseJson(row.encrypted, { v: 1, alg: 'aes-256-gcm', iv: '', tag: '', ciphertext: '', fp: '' }),
    displayHint: String(row.display_hint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
    lastValidatedAt: row.last_validated_at === null ? null : String(row.last_validated_at),
    validationState: String(row.validation_state) as CredentialRecord['validationState'],
    validationDetail: row.validation_detail === null ? null : String(row.validation_detail),
  });

  return {
    list(providerId?: string) {
      const rows = providerId
        ? db.all<Row>('SELECT * FROM credentials WHERE provider_id = ? ORDER BY field', [providerId])
        : db.all<Row>('SELECT * FROM credentials ORDER BY provider_id, field');
      return rows.map(map);
    },
    get(providerId, field) {
      const row = db.get<Row>('SELECT * FROM credentials WHERE provider_id = ? AND field = ?', [providerId, field]);
      return row ? map(row) : null;
    },
    upsert(record) {
      db.run(
        `INSERT INTO credentials (provider_id, field, encrypted, display_hint, created_at, updated_at, last_used_at, last_validated_at, validation_state, validation_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, field) DO UPDATE SET
           encrypted = excluded.encrypted, display_hint = excluded.display_hint, updated_at = excluded.updated_at,
           last_used_at = excluded.last_used_at, last_validated_at = excluded.last_validated_at,
           validation_state = excluded.validation_state, validation_detail = excluded.validation_detail`,
        [
          record.providerId,
          record.field,
          JSON.stringify(record.encrypted),
          record.displayHint,
          record.createdAt,
          record.updatedAt,
          record.lastUsedAt,
          record.lastValidatedAt,
          record.validationState,
          record.validationDetail,
        ],
      );
    },
    delete(providerId, field) {
      return db.run('DELETE FROM credentials WHERE provider_id = ? AND field = ?', [providerId, field]).changes;
    },
    touch(providerId, field, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.lastUsedAt !== undefined) {
        sets.push('last_used_at = ?');
        params.push(patch.lastUsedAt);
      }
      if (patch.lastValidatedAt !== undefined) {
        sets.push('last_validated_at = ?');
        params.push(patch.lastValidatedAt);
      }
      if (patch.validationState !== undefined) {
        sets.push('validation_state = ?');
        params.push(patch.validationState);
      }
      if (patch.validationDetail !== undefined) {
        sets.push('validation_detail = ?');
        params.push(patch.validationDetail);
      }
      if (!sets.length) return;
      params.push(providerId, field);
      db.run(`UPDATE credentials SET ${sets.join(', ')} WHERE provider_id = ? AND field = ?`, params);
    },
  };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelQuery {
  providerId?: string;
  enabled?: boolean;
  quotaType?: QuotaType;
  capability?: keyof ModelCapabilities;
  minContextWindow?: number;
  status?: ModelStatus;
  search?: string;
  limit?: number;
}

export interface ModelRepository {
  list(query?: ModelQuery): ModelInfo[];
  get(id: string): ModelInfo | null;
  getByProviderModelId(providerId: string, providerModelId: string): ModelInfo | null;
  upsert(model: ModelInfo): ModelInfo;
  update(id: string, patch: Partial<ModelInfo>): ModelInfo | null;
  setEnabled(id: string, enabled: boolean): void;
  setStatus(id: string, status: ModelStatus): void;
  updatePerformance(id: string, performance: ModelPerformance): void;
  updateQuota(id: string, quota: ModelQuotaLimits, quotaType: QuotaType): void;
  deleteByProvider(providerId: string): number;
  countByProvider(): { providerId: string; total: number; enabled: number }[];
  markMissingAsOffline(providerId: string, seenIds: string[]): number;
}

export function createModelRepository(db: Database): ModelRepository {
  const map = (row: Row): ModelInfo => ({
    id: String(row.id),
    providerId: String(row.provider_id),
    providerModelId: String(row.provider_model_id),
    displayName: String(row.display_name),
    contextWindow: toNumber(row.context_window),
    maxOutputTokens: toNumber(row.max_output_tokens),
    capabilities: parseJson<ModelCapabilities>(row.capabilities, {} as ModelCapabilities),
    pricing: parseJson<ModelPricing>(row.pricing, {
      inputPerMillionTokens: null,
      outputPerMillionTokens: null,
      provenance: { source: 'unknown', confidence: 0 },
    }),
    quota: parseJson<ModelQuotaLimits>(row.quota_limits, {} as ModelQuotaLimits),
    quotaType: String(row.quota_type) as QuotaType,
    performance: parseJson<ModelPerformance>(row.performance, {
      averageLatency: null,
      averageFirstTokenLatency: null,
      throughput: null,
      successRate: null,
      samples: 0,
    }),
    status: String(row.status) as ModelStatus,
    enabled: toBool(row.enabled),
    priority: Number(row.priority ?? 0),
    qualityPrior: Number(row.quality_prior ?? 0.5),
    strengths: parseJson<TaskType[]>(row.strengths, []),
    discoveredAt: String(row.discovered_at),
    updatedAt: String(row.updated_at),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  });

  return {
    list(query = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.providerId) {
        where.push('provider_id = ?');
        params.push(query.providerId);
      }
      if (query.enabled !== undefined) {
        where.push('enabled = ?');
        params.push(fromBool(query.enabled));
      }
      if (query.quotaType) {
        where.push('quota_type = ?');
        params.push(query.quotaType);
      }
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.minContextWindow !== undefined) {
        where.push('(context_window IS NULL OR context_window >= ?)');
        params.push(query.minContextWindow);
      }
      if (query.search) {
        where.push('(LOWER(display_name) LIKE ? OR LOWER(provider_model_id) LIKE ? OR LOWER(id) LIKE ?)');
        const like = `%${query.search.toLowerCase()}%`;
        params.push(like, like, like);
      }
      // Capability filter uses SQLite's JSON1 extension over the capabilities column.
      if (query.capability) {
        where.push(`json_extract(capabilities, '$.${query.capability}') = 1`);
      }
      const sql = `SELECT * FROM models ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY provider_id, priority DESC, display_name LIMIT ?`;
      params.push(query.limit ?? 2000);
      return db.all<Row>(sql, params).map(map);
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM models WHERE id = ?', [id]);
      return row ? map(row) : null;
    },
    getByProviderModelId(providerId, providerModelId) {
      const row = db.get<Row>('SELECT * FROM models WHERE provider_id = ? AND provider_model_id = ?', [providerId, providerModelId]);
      return row ? map(row) : null;
    },
    upsert(model) {
      db.run(
        `INSERT INTO models (id, provider_id, provider_model_id, display_name, context_window, max_output_tokens, capabilities,
            pricing, quota_limits, quota_type, performance, status, enabled, priority, quality_prior, strengths, metadata, discovered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name, context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
           capabilities = excluded.capabilities, pricing = excluded.pricing, quota_limits = excluded.quota_limits, quota_type = excluded.quota_type,
           performance = excluded.performance, status = excluded.status, metadata = excluded.metadata, updated_at = excluded.updated_at`,
        [
          model.id,
          model.providerId,
          model.providerModelId,
          model.displayName,
          model.contextWindow,
          model.maxOutputTokens,
          JSON.stringify(model.capabilities),
          JSON.stringify(model.pricing),
          JSON.stringify(model.quota),
          model.quotaType,
          JSON.stringify(model.performance),
          model.status,
          fromBool(model.enabled),
          model.priority,
          model.qualityPrior,
          JSON.stringify(model.strengths),
          JSON.stringify(model.metadata),
          model.discoveredAt,
          model.updatedAt,
        ],
      );
      return model;
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const next: ModelInfo = { ...existing, ...patch, updatedAt: nowIso() };
      this.upsert(next);
      // enabled/priority/quality/strengths are operator-owned; upsert() deliberately
      // does not overwrite them on conflict, so persist them explicitly here.
      db.run('UPDATE models SET enabled = ?, priority = ?, quality_prior = ?, strengths = ?, status = ? WHERE id = ?', [
        fromBool(next.enabled),
        next.priority,
        next.qualityPrior,
        JSON.stringify(next.strengths),
        next.status,
        id,
      ]);
      return next;
    },
    setEnabled(id, enabled) {
      db.run('UPDATE models SET enabled = ?, updated_at = ? WHERE id = ?', [fromBool(enabled), nowIso(), id]);
    },
    setStatus(id, status) {
      db.run('UPDATE models SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
    },
    updatePerformance(id, performance) {
      db.run('UPDATE models SET performance = ?, updated_at = ? WHERE id = ?', [JSON.stringify(performance), nowIso(), id]);
    },
    updateQuota(id, quota, quotaType) {
      db.run('UPDATE models SET quota_limits = ?, quota_type = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(quota),
        quotaType,
        nowIso(),
        id,
      ]);
    },
    deleteByProvider(providerId) {
      return db.run('DELETE FROM models WHERE provider_id = ?', [providerId]).changes;
    },
    countByProvider() {
      const rows = db.all<Row>(
        'SELECT provider_id, COUNT(*) AS total, SUM(enabled) AS enabled FROM models GROUP BY provider_id',
      );
      return rows.map((r) => ({
        providerId: String(r.provider_id),
        total: Number(r.total ?? 0),
        enabled: Number(r.enabled ?? 0),
      }));
    },
    markMissingAsOffline(providerId, seenIds) {
      if (!seenIds.length) return 0;
      const placeholders = seenIds.map(() => '?').join(', ');
      const result = db.run(
        `UPDATE models SET status = 'offline', updated_at = ? WHERE provider_id = ? AND provider_model_id NOT IN (${placeholders}) AND status != 'offline'`,
        [nowIso(), providerId, ...seenIds],
      );
      return result.changes;
    },
  };
}

export type { CredentialStatus, AuthenticationType };
