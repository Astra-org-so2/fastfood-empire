import crypto from 'node:crypto';
import type { Provenance, QuotaBucket, QuotaReservation, QuotaType, QuotaWindow, RateLimitTelemetry } from '@aido/types';
import type { Database, Row } from '../db.js';
import { nowIso, parseJson, toNumber } from './helpers.js';

export interface QuotaBucketKey {
  providerId: string;
  /** Empty string = provider-wide bucket (never NULL, see schema notes). */
  scopeModel: string;
  window: QuotaWindow;
  windowStart: string;
}

export interface QuotaRepository {
  getBucket(key: QuotaBucketKey): QuotaBucket | null;
  listBuckets(providerId: string, filter?: { window?: QuotaWindow; scopeModel?: string }): QuotaBucket[];
  /** Creates the bucket if absent and returns the current state. */
  ensureBucket(key: QuotaBucketKey, limits: { limitTokens: number | null; limitRequests: number | null; windowEnd: string }): QuotaBucket;
  /**
   * Atomic reservation: increments reserved_* counters only if the requested
   * amount fits inside the remaining budget. Returns false when it does not.
   * Must be called inside a transaction spanning all buckets of a reservation.
   */
  /**
   * Totals for every bucket of a window whose start falls inside [from, to).
   * Reserved (in-flight) amounts are included: a rolling window that ignored
   * in-flight reservations would let concurrent agents overshoot it.
   */
  sumBuckets(
    providerId: string,
    scopeModel: string,
    window: QuotaWindow,
    from: string,
    to: string,
  ): { tokens: number; requests: number; buckets: number };
  tryReserve(bucketId: string, tokens: number, requests: number, limits: { limitTokens: number | null; limitRequests: number | null; reserveFraction: number }): boolean;
  commit(bucketId: string, reservedTokens: number, reservedRequests: number, actualTokens: number, actualRequests: number): void;
  release(bucketId: string, reservedTokens: number, reservedRequests: number): void;
  setLimits(bucketId: string, limits: { limitTokens: number | null; limitRequests: number | null; windowEnd: string }): void;
  resetBucket(bucketId: string): void;
  deleteOldBuckets(before: string): number;

  createReservation(reservation: QuotaReservation): QuotaReservation;
  getReservation(id: string): QuotaReservation | null;
  settleReservation(id: string, patch: { status: QuotaReservation['status']; settledTokens?: number }): void;
  openReservations(providerId?: string): QuotaReservation[];
  expireReservations(now: string): QuotaReservation[];

  recordObservation(observation: {
    providerId: string;
    scopeModel: string;
    telemetry: RateLimitTelemetry;
    source: Provenance['source'];
    provenance: Provenance;
  }): void;
  latestObservation(providerId: string, scopeModel: string): Row | null;
  observedLimits(providerId: string, scopeModel: string): { limitRequests: number | null; limitTokens: number | null; observedAt: string } | null;
}

export function createQuotaRepository(db: Database): QuotaRepository {
  const mapBucket = (row: Row): QuotaBucket => ({
    id: String(row.id),
    providerId: String(row.provider_id),
    modelId: String(row.scope_model) === '' ? null : String(row.scope_model),
    window: String(row.window) as QuotaWindow,
    windowStart: String(row.window_start),
    windowEnd: String(row.window_end),
    limitTokens: toNumber(row.limit_tokens),
    usedTokens: Number(row.used_tokens ?? 0),
    reservedTokens: Number(row.reserved_tokens ?? 0),
    limitRequests: toNumber(row.limit_requests),
    usedRequests: Number(row.used_requests ?? 0),
    reservedRequests: Number(row.reserved_requests ?? 0),
    updatedAt: String(row.updated_at),
  });

  const bucketId = (key: QuotaBucketKey) => `${key.providerId}|${key.scopeModel}|${key.window}|${key.windowStart}`;

  return {
    getBucket(key) {
      const row = db.get<Row>(
        'SELECT * FROM quota_buckets WHERE provider_id = ? AND scope_model = ? AND window = ? AND window_start = ?',
        [key.providerId, key.scopeModel, key.window, key.windowStart],
      );
      return row ? mapBucket(row) : null;
    },
    sumBuckets(providerId, scopeModel, window, from, to) {
      const row = db.get<Row>(
        `SELECT COALESCE(SUM(used_tokens + reserved_tokens), 0) AS tokens,
                COALESCE(SUM(used_requests + reserved_requests), 0) AS requests,
                COUNT(*) AS buckets
           FROM quota_buckets
          WHERE provider_id = ? AND scope_model = ? AND window = ? AND window_start >= ? AND window_start < ?`,
        [providerId, scopeModel, window, from, to],
      );
      return {
        tokens: Number(row?.tokens ?? 0),
        requests: Number(row?.requests ?? 0),
        buckets: Number(row?.buckets ?? 0),
      };
    },
    listBuckets(providerId, filter = {}) {
      const where = ['provider_id = ?'];
      const params: unknown[] = [providerId];
      if (filter.window) {
        where.push('window = ?');
        params.push(filter.window);
      }
      if (filter.scopeModel !== undefined) {
        where.push('scope_model = ?');
        params.push(filter.scopeModel);
      }
      return db
        .all<Row>(`SELECT * FROM quota_buckets WHERE ${where.join(' AND ')} ORDER BY window_start DESC`, params)
        .map(mapBucket);
    },
    ensureBucket(key, limits) {
      const existing = this.getBucket(key);
      if (existing) return existing;
      const id = bucketId(key);
      db.run(
        `INSERT INTO quota_buckets (id, provider_id, scope_model, window, window_start, window_end, limit_tokens, used_tokens, reserved_tokens, limit_requests, used_requests, reserved_requests, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, ?)
         ON CONFLICT(id) DO NOTHING`,
        [id, key.providerId, key.scopeModel, key.window, key.windowStart, limits.windowEnd, limits.limitTokens, limits.limitRequests, nowIso()],
      );
      return this.getBucket(key)!;
    },
    tryReserve(bucketIdValue, tokens, requests, limits) {
      // Read-modify-write inside the caller's transaction. The guard condition is
      // re-evaluated in SQL so two callers cannot both pass the same check.
      const row = db.get<Row>('SELECT * FROM quota_buckets WHERE id = ?', [bucketIdValue]);
      if (!row) return false;
      const bucket = mapBucket(row);

      const reserveFraction = limits.reserveFraction;
      if (limits.limitTokens !== null) {
        // Keep a safety margin so agents never consume the very last token and
        // strand an in-flight request on a 429.
        const reservable = limits.limitTokens * (1 - reserveFraction);
        if (bucket.usedTokens + bucket.reservedTokens + tokens > reservable) return false;
      }
      if (limits.limitRequests !== null) {
        const reservable = limits.limitRequests * (1 - reserveFraction);
        if (bucket.usedRequests + bucket.reservedRequests + requests > reservable) return false;
      }
      db.run(
        'UPDATE quota_buckets SET reserved_tokens = reserved_tokens + ?, reserved_requests = reserved_requests + ?, updated_at = ? WHERE id = ?',
        [tokens, requests, nowIso(), bucketIdValue],
      );
      return true;
    },
    commit(bucketIdValue, reservedTokens, reservedRequests, actualTokens, actualRequests) {
      db.run(
        `UPDATE quota_buckets SET
           reserved_tokens = MAX(0, reserved_tokens - ?),
           reserved_requests = MAX(0, reserved_requests - ?),
           used_tokens = used_tokens + ?,
           used_requests = used_requests + ?,
           updated_at = ?
         WHERE id = ?`,
        [reservedTokens, reservedRequests, actualTokens, actualRequests, nowIso(), bucketIdValue],
      );
    },
    release(bucketIdValue, reservedTokens, reservedRequests) {
      db.run(
        'UPDATE quota_buckets SET reserved_tokens = MAX(0, reserved_tokens - ?), reserved_requests = MAX(0, reserved_requests - ?), updated_at = ? WHERE id = ?',
        [reservedTokens, reservedRequests, nowIso(), bucketIdValue],
      );
    },
    setLimits(bucketIdValue, limits) {
      db.run('UPDATE quota_buckets SET limit_tokens = ?, limit_requests = ?, window_end = ?, updated_at = ? WHERE id = ?', [
        limits.limitTokens,
        limits.limitRequests,
        limits.windowEnd,
        nowIso(),
        bucketIdValue,
      ]);
    },
    resetBucket(bucketIdValue) {
      db.run('UPDATE quota_buckets SET used_tokens = 0, reserved_tokens = 0, used_requests = 0, reserved_requests = 0, updated_at = ? WHERE id = ?', [
        nowIso(),
        bucketIdValue,
      ]);
    },
    deleteOldBuckets(before) {
      return db.run('DELETE FROM quota_buckets WHERE window_end < ?', [before]).changes;
    },

    createReservation(reservation) {
      db.run(
        `INSERT INTO quota_reservations (id, provider_id, model_id, bucket_ids, estimated_tokens, trace_id, task_id, agent_id, created_at, expires_at, settled_at, settled_tokens, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reservation.id,
          reservation.providerId,
          reservation.modelId,
          JSON.stringify(reservation.bucketIds),
          reservation.estimatedTokens,
          reservation.traceId,
          reservation.taskId,
          reservation.agentId,
          reservation.createdAt,
          reservation.expiresAt,
          reservation.settledAt,
          reservation.settledTokens,
          reservation.status,
        ],
      );
      return reservation;
    },
    getReservation(id) {
      const row = db.get<Row>('SELECT * FROM quota_reservations WHERE id = ?', [id]);
      if (!row) return null;
      return {
        id: String(row.id),
        providerId: String(row.provider_id),
        modelId: String(row.model_id),
        bucketIds: parseJson<string[]>(row.bucket_ids, []),
        estimatedTokens: Number(row.estimated_tokens ?? 0),
        traceId: String(row.trace_id),
        taskId: row.task_id === null ? null : String(row.task_id),
        agentId: row.agent_id === null ? null : String(row.agent_id),
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
        settledAt: row.settled_at === null ? null : String(row.settled_at),
        settledTokens: toNumber(row.settled_tokens),
        status: String(row.status) as QuotaReservation['status'],
      };
    },
    settleReservation(id, patch) {
      db.run('UPDATE quota_reservations SET status = ?, settled_at = ?, settled_tokens = ? WHERE id = ?', [
        patch.status,
        nowIso(),
        patch.settledTokens ?? null,
        id,
      ]);
    },
    openReservations(providerId) {
      const rows = providerId
        ? db.all<Row>("SELECT * FROM quota_reservations WHERE status = 'reserved' AND provider_id = ?", [providerId])
        : db.all<Row>("SELECT * FROM quota_reservations WHERE status = 'reserved'");
      return rows.map((row) => ({
        id: String(row.id),
        providerId: String(row.provider_id),
        modelId: String(row.model_id),
        bucketIds: parseJson<string[]>(row.bucket_ids, []),
        estimatedTokens: Number(row.estimated_tokens ?? 0),
        traceId: String(row.trace_id),
        taskId: row.task_id === null ? null : String(row.task_id),
        agentId: row.agent_id === null ? null : String(row.agent_id),
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
        settledAt: null,
        settledTokens: null,
        status: 'reserved' as const,
      }));
    },
    expireReservations(now) {
      const rows = db.all<Row>("SELECT * FROM quota_reservations WHERE status = 'reserved' AND expires_at < ?", [now]);
      const expired: QuotaReservation[] = [];
      for (const row of rows) {
        const reservation: QuotaReservation = {
          id: String(row.id),
          providerId: String(row.provider_id),
          modelId: String(row.model_id),
          bucketIds: parseJson<string[]>(row.bucket_ids, []),
          estimatedTokens: Number(row.estimated_tokens ?? 0),
          traceId: String(row.trace_id),
          taskId: row.task_id === null ? null : String(row.task_id),
          agentId: row.agent_id === null ? null : String(row.agent_id),
          createdAt: String(row.created_at),
          expiresAt: String(row.expires_at),
          settledAt: null,
          settledTokens: null,
          status: 'expired',
        };
        expired.push(reservation);
      }
      if (expired.length) {
        const ids = expired.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(', ');
        db.run(`UPDATE quota_reservations SET status = 'expired', settled_at = ? WHERE id IN (${placeholders})`, [now, ...ids]);
      }
      return expired;
    },

    recordObservation({ providerId, scopeModel, telemetry, source, provenance }) {
      db.run(
        `INSERT INTO quota_observations (id, provider_id, scope_model, observed_at, limit_requests, remaining_requests, limit_tokens, remaining_tokens, reset_requests, reset_tokens, source, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          providerId,
          scopeModel,
          nowIso(),
          telemetry.requestsLimit ?? null,
          telemetry.requestsRemaining ?? null,
          telemetry.tokensLimit ?? null,
          telemetry.tokensRemaining ?? null,
          telemetry.resetRequests ?? null,
          telemetry.resetTokens ?? null,
          source,
          JSON.stringify(provenance),
        ],
      );
    },
    latestObservation(providerId, scopeModel) {
      return db.get<Row>(
        'SELECT * FROM quota_observations WHERE provider_id = ? AND scope_model = ? ORDER BY observed_at DESC LIMIT 1',
        [providerId, scopeModel],
      );
    },
    observedLimits(providerId, scopeModel) {
      const read = (scope: string) =>
        db.all<Row>(
          `SELECT limit_requests, limit_tokens, observed_at FROM quota_observations
           WHERE provider_id = ? AND scope_model = ? AND (limit_requests IS NOT NULL OR limit_tokens IS NOT NULL)
           ORDER BY observed_at DESC LIMIT 20`,
          [providerId, scope],
        );
      let rows = scopeModel ? read(scopeModel) : [];
      // Rate-limit headers describe the key/account, not one model, so most observations
      // are stored provider-scoped. A per-model question must still see them, otherwise
      // the "observed headers override configured estimates" path silently does nothing.
      if (!rows.length) rows = read('');
      if (!rows.length) return null;
      // The provider sometimes reports a request-only or token-only limit; take the
      // maximum observed per dimension rather than the newest, because a burst of
      // per-minute limits must not overwrite the daily ceiling with a tiny number.
      const limitRequests = rows.reduce<number | null>((acc, r) => {
        const v = toNumber(r.limit_requests);
        return v === null ? acc : acc === null ? v : Math.max(acc, v);
      }, null);
      const limitTokens = rows.reduce<number | null>((acc, r) => {
        const v = toNumber(r.limit_tokens);
        return v === null ? acc : acc === null ? v : Math.max(acc, v);
      }, null);
      return { limitRequests, limitTokens, observedAt: String(rows[0]!.observed_at) };
    },
  };
}

export type { QuotaType };
