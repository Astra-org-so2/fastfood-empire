import crypto from 'node:crypto';
import type { Database, Row } from '../db.js';
import { nowIso } from './helpers.js';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  revokedAt: string | null;
}

export interface UserRepository {
  /** Returns the single local owner, creating it on first run. */
  ensureLocalOwner(): UserRecord;
  get(id: string): UserRecord | null;
  createSession(userId: string, token: string, ttlMs: number, userAgent?: string | null): SessionRecord;
  findSession(token: string): (SessionRecord & { user: UserRecord }) | null;
  touchSession(token: string): void;
  revokeSession(token: string): void;
  revokeAll(userId: string): number;
  purgeExpired(now: string): number;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Single-user local application, but modelled with users+sessions so that remote
 * or multi-user deployment does not require a schema migration later. Sessions are
 * stored hashed: a database leak does not hand over live tokens.
 */
export function createUserRepository(db: Database): UserRepository {
  const mapUser = (row: Row): UserRecord => ({
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: String(row.role),
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
  });

  return {
    ensureLocalOwner() {
      const existing = db.get<Row>("SELECT * FROM users WHERE username = 'local'");
      if (existing) return mapUser(existing);
      const user: UserRecord = {
        id: crypto.randomUUID(),
        username: 'local',
        displayName: 'Local operator',
        role: 'owner',
        createdAt: nowIso(),
        lastSeenAt: null,
      };
      db.run('INSERT INTO users (id, username, display_name, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)', [
        user.id,
        user.username,
        user.displayName,
        user.role,
        user.createdAt,
      ]);
      return user;
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM users WHERE id = ?', [id]);
      return row ? mapUser(row) : null;
    },
    createSession(userId, token, ttlMs, userAgent) {
      const now = new Date();
      const session: SessionRecord = {
        tokenHash: hashToken(token),
        userId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        lastSeenAt: now.toISOString(),
        userAgent: userAgent ?? null,
        revokedAt: null,
      };
      db.run(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        [session.tokenHash, session.userId, session.createdAt, session.expiresAt, session.lastSeenAt, session.userAgent],
      );
      return session;
    },
    findSession(token) {
      const row = db.get<Row>('SELECT * FROM sessions WHERE token_hash = ?', [hashToken(token)]);
      if (!row) return null;
      const session: SessionRecord = {
        tokenHash: String(row.token_hash),
        userId: String(row.user_id),
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
        lastSeenAt: String(row.last_seen_at),
        userAgent: row.user_agent === null ? null : String(row.user_agent),
        revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      };
      if (session.revokedAt || session.expiresAt < nowIso()) return null;
      const user = this.get(session.userId);
      return user ? { ...session, user } : null;
    },
    touchSession(token) {
      db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [nowIso(), hashToken(token)]);
    },
    revokeSession(token) {
      db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [nowIso(), hashToken(token)]);
    },
    revokeAll(userId) {
      return db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]).changes;
    },
    purgeExpired(now) {
      return db.run('DELETE FROM sessions WHERE expires_at < ?', [now]).changes;
    },
  };
}
