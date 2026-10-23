import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { PATHS } from './paths.ts';

let db: DatabaseSync | null = null;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE apps (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    env_enc TEXT NOT NULL DEFAULT '',
    secrets_enc TEXT NOT NULL DEFAULT '',
    desired_state TEXT NOT NULL DEFAULT 'running',
    deployed_sha TEXT,
    deployed_at INTEGER,
    last_seen_sha TEXT,
    rejected_sha TEXT,
    deps_hash TEXT,
    last_poll_at INTEGER,
    last_poll_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE deploys (
    id INTEGER PRIMARY KEY,
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    from_sha TEXT,
    to_sha TEXT,
    commits TEXT NOT NULL DEFAULT '[]',
    scheduled_at INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    triggered_by TEXT,
    approved_by TEXT,
    error TEXT
  );
  CREATE INDEX deploys_app ON deploys(app_id, id DESC);
  CREATE INDEX deploys_status ON deploys(status);
  CREATE TABLE databases (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    secrets_enc TEXT NOT NULL DEFAULT '',
    desired_state TEXT NOT NULL DEFAULT 'running',
    initialized INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE app_links (
    app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    prefix TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (app_id, database_id)
  );
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    target_slug TEXT NOT NULL,
    file TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX backups_target ON backups(kind, target_slug, id DESC);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    username TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE INDEX audit_ts ON audit(ts DESC);
  `,
];

export function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  db = new DatabaseSync(PATHS.db);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      v++;
      db.prepare('UPDATE schema_version SET v = ?').run(v);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  try {
    fs.chmodSync(PATHS.db, 0o600);
  } catch {
    /* noop */
  }
  return db;
}

type P = SQLInputValue;

export const q = {
  get<T>(sql: string, ...params: P[]): T | undefined {
    return openDb().prepare(sql).get(...params) as T | undefined;
  },
  all<T>(sql: string, ...params: P[]): T[] {
    return openDb().prepare(sql).all(...params) as T[];
  },
  run(sql: string, ...params: P[]) {
    return openDb().prepare(sql).run(...params);
  },
  tx<T>(fn: () => T): T {
    const d = openDb();
    d.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      d.exec('COMMIT');
      return r;
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  },
};

export function getSetting<T>(key: string, fallback: T): T {
  const row = q.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    const v = JSON.parse(row.value) as T;
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback) && v && typeof v === 'object') {
      return { ...fallback, ...v };
    }
    return v;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown) {
  q.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export const now = () => Date.now();
