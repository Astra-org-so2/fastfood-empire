import crypto from 'node:crypto';
import type { MemoryEntry, MemoryKind, TaskType } from '@aido/types';
import type { Database, Row } from '../db.js';
import { nowIso, parseJson } from './helpers.js';

export interface MemoryQuery {
  kinds?: MemoryKind[];
  relatedFiles?: string[];
  taskTypes?: TaskType[];
  includeSuperseded?: boolean;
  minImportance?: number;
  limit?: number;
  /** Full-text-ish search over title/body/key. */
  search?: string;
}

export interface MemoryRepository {
  list(projectId: string, query?: MemoryQuery): MemoryEntry[];
  get(id: string): MemoryEntry | null;
  findByKey(projectId: string, key: string): MemoryEntry[];
  upsert(entry: Omit<MemoryEntry, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): MemoryEntry;
  /** Marks an entry as superseded (history preserved for audit, excluded from prompts). */
  supersede(id: string, supersededById: string): void;
  touch(id: string): void;
  delete(id: string): boolean;
  /** Body text of the most recent non-superseded entry per key, for context assembly. */
  latestByKey(projectId: string): Map<string, MemoryEntry>;
  stats(projectId: string): { kind: MemoryKind; count: number }[];
}

function mapEntry(row: Row): MemoryEntry {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind) as MemoryKind,
    key: String(row.key),
    title: String(row.title),
    body: String(row.body),
    supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
    relatedFiles: parseJson<string[]>(row.related_files, []),
    relatedTaskTypes: parseJson<TaskType[]>(row.related_task_types, []),
    importance: Number(row.importance ?? 0.5),
    sourceTaskId: row.source_task_id === null ? null : String(row.source_task_id),
    sourceAgentId: row.source_agent_id === null ? null : String(row.source_agent_id),
    trust: String(row.trust) as MemoryEntry['trust'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Content hash lets us skip writing a memory entry that is byte-identical to the
 * current one — summarisation passes run often and would otherwise spam the table.
 */
function contentHash(entry: { kind: string; key: string; title: string; body: string }): string {
  return crypto.createHash('sha256').update(`${entry.kind}\u0000${entry.key}\u0000${entry.title}\u0000${entry.body}`).digest('hex').slice(0, 32);
}

export function createMemoryRepository(db: Database): MemoryRepository {
  return {
    list(projectId, query = {}) {
      const where = ['project_id = ?'];
      const params: unknown[] = [projectId];
      if (!query.includeSuperseded) where.push('superseded_by IS NULL');
      if (query.kinds?.length) {
        where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
        params.push(...query.kinds);
      }
      if (query.minImportance !== undefined) {
        where.push('importance >= ?');
        params.push(query.minImportance);
      }
      if (query.search) {
        where.push('(LOWER(title) LIKE ? OR LOWER(body) LIKE ? OR LOWER(key) LIKE ?)');
        const like = `%${query.search.toLowerCase()}%`;
        params.push(like, like, like);
      }
      const sql = `SELECT * FROM memory_entries WHERE ${where.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`;
      params.push(query.limit ?? 500);
      let entries = db.all<Row>(sql, params).map(mapEntry);

      // Relevance filtering for arrays is done in JS: the candidate set is already
      // bounded by project + limit, and SQL JSON array intersections would be
      // unreadable for the marginal benefit.
      if (query.relatedFiles?.length) {
        const wanted = new Set(query.relatedFiles);
        entries = entries.filter((e) => e.relatedFiles.length === 0 || e.relatedFiles.some((f) => wanted.has(f)));
      }
      if (query.taskTypes?.length) {
        const wanted = new Set<string>(query.taskTypes);
        entries = entries.filter((e) => e.relatedTaskTypes.length === 0 || e.relatedTaskTypes.some((t) => wanted.has(t)));
      }
      return entries;
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM memory_entries WHERE id = ?', [id]);
      return row ? mapEntry(row) : null;
    },
    findByKey(projectId, key) {
      return db.all<Row>('SELECT * FROM memory_entries WHERE project_id = ? AND key = ? ORDER BY updated_at DESC', [projectId, key]).map(mapEntry);
    },
    upsert(entry) {
      const now = nowIso();
      const hash = contentHash(entry);
      const existing = db.get<Row>('SELECT * FROM memory_entries WHERE project_id = ? AND key = ? AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT 1', [
        entry.projectId,
        entry.key,
      ]);
      if (existing && String(existing.content_hash) === hash) {
        db.run('UPDATE memory_entries SET updated_at = ? WHERE id = ?', [now, String(existing.id)]);
        return mapEntry({ ...existing, updated_at: now });
      }
      const id = entry.id || crypto.randomUUID();
      const record: MemoryEntry = {
        ...entry,
        id,
        createdAt: entry.createdAt ?? now,
        updatedAt: entry.updatedAt ?? now,
      };
      db.transaction(() => {
        if (existing) {
          // New version of the same key: supersede the previous one rather than
          // deleting it, so "why did the architecture change?" stays answerable.
          db.run('UPDATE memory_entries SET superseded_by = ?, updated_at = ? WHERE id = ?', [id, now, String(existing.id)]);
        }
        db.run(
          `INSERT INTO memory_entries (id, project_id, kind, key, title, body, superseded_by, related_files, related_task_types,
             importance, source_task_id, source_agent_id, trust, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, kind = excluded.kind,
             related_files = excluded.related_files, related_task_types = excluded.related_task_types,
             importance = excluded.importance, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
          [
            record.id,
            record.projectId,
            record.kind,
            record.key,
            record.title,
            record.body,
            record.supersededBy,
            JSON.stringify(record.relatedFiles),
            JSON.stringify(record.relatedTaskTypes),
            record.importance,
            record.sourceTaskId,
            record.sourceAgentId,
            record.trust,
            hash,
            record.createdAt,
            record.updatedAt,
          ],
        );
      });
      return record;
    },
    supersede(id, supersededById) {
      db.run('UPDATE memory_entries SET superseded_by = ?, updated_at = ? WHERE id = ?', [supersededById, nowIso(), id]);
    },
    touch(id) {
      db.run('UPDATE memory_entries SET updated_at = ? WHERE id = ?', [nowIso(), id]);
    },
    delete(id) {
      return db.run('DELETE FROM memory_entries WHERE id = ?', [id]).changes > 0;
    },
    latestByKey(projectId) {
      const rows = db.all<Row>('SELECT * FROM memory_entries WHERE project_id = ? AND superseded_by IS NULL ORDER BY updated_at DESC', [projectId]);
      const result = new Map<string, MemoryEntry>();
      for (const row of rows) {
        const entry = mapEntry(row);
        if (!result.has(entry.key)) result.set(entry.key, entry);
      }
      return result;
    },
    stats(projectId) {
      return db
        .all<Row>('SELECT kind, COUNT(*) AS c FROM memory_entries WHERE project_id = ? AND superseded_by IS NULL GROUP BY kind', [projectId])
        .map((r) => ({ kind: String(r.kind) as MemoryKind, count: Number(r.c ?? 0) }));
    },
  };
}
