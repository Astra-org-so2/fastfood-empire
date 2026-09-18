import crypto from 'node:crypto';
import type { AgentId } from '@aido/types';
import type { Database, Row } from '../db.js';
import { nowIso, parseJson, toNumber } from './helpers.js';

export interface CommitRecord {
  projectId: string;
  sha: string;
  branch: string;
  message: string;
  authorName: string;
  authorEmail: string;
  agentId: AgentId | null;
  taskId: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  committedAt: string;
}

export interface CommitRepository {
  record(commit: CommitRecord): void;
  list(projectId: string, limit?: number): CommitRecord[];
  byAgent(projectId: string): { agentId: string | null; commits: number; insertions: number; deletions: number }[];
  purgeMissing(projectId: string, existingShas: string[]): number;
}

export function createCommitRepository(db: Database): CommitRepository {
  const map = (row: Row): CommitRecord => ({
    projectId: String(row.project_id),
    sha: String(row.sha),
    branch: String(row.branch),
    message: String(row.message),
    authorName: String(row.author_name),
    authorEmail: String(row.author_email),
    agentId: row.agent_id === null ? null : (String(row.agent_id) as AgentId),
    taskId: row.task_id === null ? null : String(row.task_id),
    filesChanged: Number(row.files_changed ?? 0),
    insertions: Number(row.insertions ?? 0),
    deletions: Number(row.deletions ?? 0),
    committedAt: String(row.committed_at),
  });

  return {
    record(commit) {
      db.run(
        `INSERT INTO git_commits (project_id, sha, branch, message, author_name, author_email, agent_id, task_id, files_changed, insertions, deletions, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, sha) DO UPDATE SET message = excluded.message, branch = excluded.branch,
           files_changed = excluded.files_changed, insertions = excluded.insertions, deletions = excluded.deletions`,
        [
          commit.projectId,
          commit.sha,
          commit.branch,
          commit.message,
          commit.authorName,
          commit.authorEmail,
          commit.agentId,
          commit.taskId,
          commit.filesChanged,
          commit.insertions,
          commit.deletions,
          commit.committedAt,
        ],
      );
    },
    list(projectId, limit = 100) {
      return db.all<Row>('SELECT * FROM git_commits WHERE project_id = ? ORDER BY committed_at DESC LIMIT ?', [projectId, limit]).map(map);
    },
    byAgent(projectId) {
      return db
        .all<Row>(
          `SELECT agent_id, COUNT(*) AS commits, SUM(insertions) AS insertions, SUM(deletions) AS deletions
           FROM git_commits WHERE project_id = ? GROUP BY agent_id ORDER BY commits DESC`,
          [projectId],
        )
        .map((r) => ({
          agentId: r.agent_id === null ? null : String(r.agent_id),
          commits: Number(r.commits ?? 0),
          insertions: Number(r.insertions ?? 0),
          deletions: Number(r.deletions ?? 0),
        }));
    },
    purgeMissing(projectId, existingShas) {
      // When history is rewritten (rebase/reset), stale rows would inflate metrics.
      if (!existingShas.length) return db.run('DELETE FROM git_commits WHERE project_id = ?', [projectId]).changes;
      const placeholders = existingShas.map(() => '?').join(', ');
      return db
        .run(`DELETE FROM git_commits WHERE project_id = ? AND sha NOT IN (${placeholders})`, [projectId, ...existingShas]).changes;
    },
  };
}

// ---------------------------------------------------------------------------
// Test runs
// ---------------------------------------------------------------------------

export interface TestRunRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  suite: string;
  command: string;
  framework: string | null;
  status: 'running' | 'passed' | 'failed' | 'error' | 'skipped';
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
  coverage: Record<string, unknown> | null;
}

export interface TestCaseRecord {
  id: string;
  runId: string;
  name: string;
  status: string;
  durationMs: number | null;
  message: string | null;
  file: string | null;
}

export interface TestRepository {
  startRun(record: Omit<TestRunRecord, 'id'> & { id?: string }): TestRunRecord;
  finishRun(id: string, patch: Partial<Omit<TestRunRecord, 'id' | 'projectId'>>): void;
  addCases(runId: string, cases: Omit<TestCaseRecord, 'id' | 'runId'>[]): void;
  listRuns(projectId: string, limit?: number): TestRunRecord[];
  getRun(id: string): TestRunRecord | null;
  cases(runId: string): TestCaseRecord[];
  latestForProject(projectId: string): TestRunRecord | null;
  summary(projectId: string, since: string): { runs: number; passed: number; failed: number; lastStatus: string | null };
}

export function createTestRepository(db: Database): TestRepository {
  const mapRun = (row: Row): TestRunRecord => ({
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    suite: String(row.suite),
    command: String(row.command),
    framework: row.framework === null ? null : String(row.framework),
    status: String(row.status) as TestRunRecord['status'],
    passed: Number(row.passed ?? 0),
    failed: Number(row.failed ?? 0),
    skipped: Number(row.skipped ?? 0),
    durationMs: toNumber(row.duration_ms),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    output: row.output === null ? null : String(row.output),
    coverage: parseJson<Record<string, unknown> | null>(row.coverage, null),
  });

  return {
    startRun(record) {
      const id = record.id ?? crypto.randomUUID();
      db.run(
        `INSERT INTO test_runs (id, project_id, task_id, suite, command, framework, status, passed, failed, skipped, duration_ms, started_at, finished_at, output, coverage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          record.projectId,
          record.taskId,
          record.suite,
          record.command,
          record.framework,
          record.status,
          record.passed,
          record.failed,
          record.skipped,
          record.durationMs,
          record.startedAt,
          record.finishedAt ?? null,
          record.output ?? null,
          record.coverage ? JSON.stringify(record.coverage) : null,
        ],
      );
      return { ...record, id };
    },
    finishRun(id, patch) {
      const existing = this.getRun(id);
      if (!existing) return;
      const next = { ...existing, ...patch };
      db.run(
        `UPDATE test_runs SET status = ?, passed = ?, failed = ?, skipped = ?, duration_ms = ?, finished_at = ?, output = ?, coverage = ? WHERE id = ?`,
        [
          next.status,
          next.passed,
          next.failed,
          next.skipped,
          next.durationMs,
          next.finishedAt ?? nowIso(),
          next.output,
          next.coverage ? JSON.stringify(next.coverage) : null,
          id,
        ],
      );
    },
    addCases(runId, cases) {
      db.transaction(() => {
        for (const testCase of cases) {
          db.run('INSERT INTO test_cases (id, run_id, name, status, duration_ms, message, file) VALUES (?, ?, ?, ?, ?, ?, ?)', [
            crypto.randomUUID(),
            runId,
            testCase.name,
            testCase.status,
            testCase.durationMs,
            testCase.message,
            testCase.file,
          ]);
        }
      });
    },
    listRuns(projectId, limit = 50) {
      return db.all<Row>('SELECT * FROM test_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?', [projectId, limit]).map(mapRun);
    },
    getRun(id) {
      const row = db.get<Row>('SELECT * FROM test_runs WHERE id = ?', [id]);
      return row ? mapRun(row) : null;
    },
    cases(runId) {
      return db.all<Row>('SELECT * FROM test_cases WHERE run_id = ? ORDER BY status, name', [runId]).map((row) => ({
        id: String(row.id),
        runId: String(row.run_id),
        name: String(row.name),
        status: String(row.status),
        durationMs: toNumber(row.duration_ms),
        message: row.message === null ? null : String(row.message),
        file: row.file === null ? null : String(row.file),
      }));
    },
    latestForProject(projectId) {
      const row = db.get<Row>('SELECT * FROM test_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 1', [projectId]);
      return row ? mapRun(row) : null;
    },
    summary(projectId, since) {
      const row = db.get<Row>(
        `SELECT COUNT(*) AS runs, SUM(passed) AS passed, SUM(failed) AS failed FROM test_runs WHERE project_id = ? AND started_at >= ?`,
        [projectId, since],
      );
      const latest = this.latestForProject(projectId);
      return {
        runs: Number(row?.runs ?? 0),
        passed: Number(row?.passed ?? 0),
        failed: Number(row?.failed ?? 0),
        lastStatus: latest?.status ?? null,
      };
    },
  };
}
