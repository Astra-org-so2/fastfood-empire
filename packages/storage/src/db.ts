import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, type Migration } from './schema.js';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface DatabaseOptions {
  path: string;
  migrate?: boolean;
  /** Applied on connect; WAL is not available for :memory:. */
  pragmas?: string[];
  logger?: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void };
  migrations?: Migration[];
}

export interface MigrationStatus {
  version: number;
  applied: string[];
  pending: string[];
}

/**
 * Thin, dependency-free SQLite wrapper.
 *
 * Why node:sqlite instead of better-sqlite3: zero native build steps, no
 * postinstall compilation, works identically in the API, the worker and the
 * Electron desktop shell — which matters for the cross-platform requirement
 * (§54) where a broken native module is the classic packaging failure.
 *
 * All parameters are normalised (booleans -> 0/1, undefined -> null) because
 * SQLite bindings reject anything else.
 */
export class Database {
  readonly raw: DatabaseSync;
  private readonly logger: DatabaseOptions['logger'];
  private readonly migrationList: Migration[];
  private depth = 0;

  constructor(options: DatabaseOptions) {
    const { path: dbPath } = options;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.logger = options.logger;
    this.migrationList = options.migrations ?? MIGRATIONS;
    this.raw = new DatabaseSync(dbPath);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (dbPath !== ':memory:') {
      // WAL gives us readers that do not block the writer — essential because the
      // worker writes traces while the API serves dashboard queries.
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
    for (const pragma of options.pragmas ?? []) this.raw.exec(pragma);
    if (options.migrate !== false) this.migrate();
  }

  /** Runs all pending migrations inside a single transaction. */
  migrate(): MigrationStatus {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const appliedRows = this.raw.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Row[];
    const appliedVersions = new Set(appliedRows.map((r) => Number(r.version)));
    const pending = this.migrationList.filter((m) => !appliedVersions.has(m.version)).sort((a, b) => a.version - b.version);

    if (pending.length) {
      this.transaction(() => {
        for (const migration of pending) {
          this.raw.exec(migration.up);
          this.raw
            .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
            .run(migration.version, migration.name, new Date().toISOString());
          this.logger?.info('migration applied', { version: migration.version, name: migration.name });
        }
      });
    }

    return {
      version: this.migrationList.length ? Math.max(...this.migrationList.map((m) => m.version)) : 0,
      applied: [...appliedVersions].sort((a, b) => a - b).map((v) => this.migrationList.find((m) => m.version === v)?.name ?? `#${v}`),
      pending: pending.map((m) => m.name),
    };
  }

  migrations(): MigrationStatus {
    const rows = this.raw.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Row[];
    const applied = rows.map((r) => String(r.name));
    const appliedVersions = new Set(rows.map((r) => Number(r.version)));
    return {
      version: appliedVersions.size ? Math.max(...appliedVersions) : 0,
      applied,
      pending: this.migrationList.filter((m) => !appliedVersions.has(m.version)).map((m) => m.name),
    };
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  /** SELECT returning many rows. */
  all<T = Row>(sql: string, params: unknown[] = []): T[] {
    return this.prepare(sql).all(...normalizeParams(params)) as T[];
  }

  /** SELECT returning one row or null. */
  get<T = Row>(sql: string, params: unknown[] = []): T | null {
    const row = this.prepare(sql).get(...normalizeParams(params));
    return (row as T | undefined) ?? null;
  }

  /** INSERT/UPDATE/DELETE. */
  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
    const result = this.prepare(sql).run(...normalizeParams(params));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Transaction wrapper. Nested calls become savepoints so a repository method
   * can be composed without breaking atomicity of the outer unit of work.
   */
  transaction<T>(fn: () => T): T {
    const isOuter = this.depth === 0;
    const savepoint = `sp_${this.depth}`;
    this.depth += 1;
    try {
      this.raw.exec(isOuter ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      const result = fn();
      this.raw.exec(isOuter ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      try {
        this.raw.exec(isOuter ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        if (!isOuter) this.raw.exec(`RELEASE ${savepoint}`);
      } catch {
        /* the transaction is already gone; surface the original error */
      }
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }

  /** Approximate on-disk size in bytes (page_count * page_size). */
  sizeBytes(): number {
    try {
      const pageCount = this.get<{ page_count: number }>('PRAGMA page_count');
      const pageSize = this.get<{ page_size: number }>('PRAGMA page_size');
      return Number(pageCount?.page_count ?? 0) * Number(pageSize?.page_size ?? 0);
    } catch {
      return 0;
    }
  }
}

export function normalizeParams(params: unknown[]): SqlValue[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number') return Number.isFinite(p) ? p : null;
    if (typeof p === 'string' || typeof p === 'bigint') return p;
    if (p instanceof Uint8Array) return p;
    if (p instanceof Date) return p.toISOString();
    // Objects/arrays are stored as JSON so callers do not have to remember.
    return JSON.stringify(p);
  });
}

export function openDatabase(options: DatabaseOptions): Database {
  return new Database(options);
}
