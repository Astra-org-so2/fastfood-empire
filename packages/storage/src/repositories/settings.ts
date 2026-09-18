import type { AppSettings } from '@aido/types';
import type { Database, Row } from '../db.js';
import { nowIso, parseJson } from './helpers.js';

export interface SettingsRepository {
  load(): { settings: AppSettings | null; updatedAt: string | null };
  save(settings: AppSettings): void;
  getState<T>(key: string, fallback: T): T;
  setState<T>(key: string, value: T): void;
  deleteState(key: string): void;
}

const SETTINGS_KEY = 'app';

export function createSettingsRepository(db: Database): SettingsRepository {
  return {
    load() {
      const row = db.get<Row>('SELECT value, updated_at FROM settings WHERE key = ?', [SETTINGS_KEY]);
      if (!row) return { settings: null, updatedAt: null };
      return { settings: parseJson<AppSettings | null>(row.value, null), updatedAt: String(row.updated_at) };
    },
    save(settings) {
      db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [SETTINGS_KEY, JSON.stringify(settings), nowIso()],
      );
    },
    getState<T>(key: string, fallback: T): T {
      const row = db.get<Row>('SELECT value FROM kv_state WHERE key = ?', [key]);
      if (!row) return fallback;
      return parseJson<T>(row.value, fallback);
    },
    setState<T>(key: string, value: T): void {
      db.run(
        `INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), nowIso()],
      );
    },
    deleteState(key: string): void {
      db.run('DELETE FROM kv_state WHERE key = ?', [key]);
    },
  };
}
