import type { Project, ProjectSettings, ProjectSpec, ProjectStatus } from '@aido/types';
import type { Database, Row } from '../db.js';
import { nowIso, parseJson } from './helpers.js';

export interface ProjectRepository {
  list(includeArchived?: boolean): Project[];
  get(id: string): Project | null;
  getBySlug(slug: string): Project | null;
  create(project: Project): Project;
  update(id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>): Project | null;
  setStatus(id: string, status: ProjectStatus): void;
  delete(id: string): boolean;
  count(): number;
}

export function createProjectRepository(db: Database): ProjectRepository {
  const mapRow = (row: Row): Project => ({
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ''),
    spec: parseJson<ProjectSpec>(row.spec, {
      goal: '',
      description: '',
      techStack: [],
      constraints: [],
      nonFunctional: [],
      acceptanceCriteria: [],
      targetUsers: '',
      deliverable: '',
    }),
    status: String(row.status) as ProjectStatus,
    workspacePath: String(row.workspace_path),
    branch: String(row.branch),
    sourceRepo: row.source_repo === null ? null : String(row.source_repo),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
    settings: parseJson<ProjectSettings>(row.settings, {} as ProjectSettings),
  });

  return {
    list(includeArchived = false) {
      const rows = includeArchived
        ? db.all<Row>('SELECT * FROM projects ORDER BY updated_at DESC')
        : db.all<Row>('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC');
      return rows.map(mapRow);
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM projects WHERE id = ?', [id]);
      return row ? mapRow(row) : null;
    },
    getBySlug(slug) {
      const row = db.get<Row>('SELECT * FROM projects WHERE slug = ?', [slug]);
      return row ? mapRow(row) : null;
    },
    create(project) {
      db.run(
        `INSERT INTO projects (id, name, slug, description, spec, status, workspace_path, branch, source_repo, settings, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project.id,
          project.name,
          project.slug,
          project.description,
          JSON.stringify(project.spec),
          project.status,
          project.workspacePath,
          project.branch,
          project.sourceRepo,
          JSON.stringify(project.settings),
          project.createdAt,
          project.updatedAt,
          project.archivedAt,
        ],
      );
      return project;
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const next: Project = { ...existing, ...patch, updatedAt: nowIso() };
      db.run(
        `UPDATE projects SET name = ?, slug = ?, description = ?, spec = ?, status = ?, workspace_path = ?, branch = ?, source_repo = ?, settings = ?, updated_at = ?, archived_at = ?
         WHERE id = ?`,
        [
          next.name,
          next.slug,
          next.description,
          JSON.stringify(next.spec),
          next.status,
          next.workspacePath,
          next.branch,
          next.sourceRepo,
          JSON.stringify(next.settings),
          next.updatedAt,
          next.archivedAt,
          id,
        ],
      );
      return next;
    },
    setStatus(id, status) {
      db.run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), id]);
    },
    delete(id) {
      return db.run('DELETE FROM projects WHERE id = ?', [id]).changes > 0;
    },
    count() {
      const row = db.get<Row>('SELECT COUNT(*) AS c FROM projects WHERE archived_at IS NULL');
      return Number(row?.c ?? 0);
    },
  };
}
