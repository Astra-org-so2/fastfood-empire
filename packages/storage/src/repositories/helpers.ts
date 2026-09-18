import type { Database } from '../db.js';

/** Shared helpers for repositories: JSON columns, boolean columns, projections. */

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function fromBool(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** ISO bucket (e.g. '2026-01-31T14:00:00.000Z' -> '2026-01-31T14:00:00Z'). */
export function isoBucket(date: Date, granularity: 'minute' | 'hour' | 'day'): string {
  const iso = date.toISOString();
  if (granularity === 'day') return `${iso.slice(0, 10)}T00:00:00Z`;
  if (granularity === 'hour') return `${iso.slice(0, 13)}:00:00Z`;
  return `${iso.slice(0, 16)}:00Z`;
}

export function grainToSql(granularity: 'minute' | 'hour' | 'day', column: string): string {
  if (granularity === 'day') return `substr(${column}, 1, 10) || 'T00:00:00Z'`;
  if (granularity === 'hour') return `substr(${column}, 1, 13) || ':00:00Z'`;
  return `substr(${column}, 1, 16) || ':00Z'`;
}

/** Builds `IN (?,?,?)` with the right arity, returning the SQL fragment + params. */
export function inClause(values: (string | number)[], prefix: string): { sql: string; params: (string | number)[] } {
  if (!values.length) return { sql: '0=1', params: [] };
  return { sql: `${values.map(() => '?').join(', ')}`, params: values };
}

export interface RepoContext {
  db: Database;
}

export function nowIso(): string {
  return new Date().toISOString();
}
