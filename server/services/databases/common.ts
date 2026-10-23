import path from 'node:path';
import { decryptJSON, encryptJSON } from '../../lib/crypto.ts';
import { now, q } from '../../lib/db.ts';
import { dbDir, UNIT } from '../../lib/paths.ts';
import { NO_LIMITS } from '../../lib/settings.ts';
import type { BackupSchedule, Db, DbConfig, DbRow, DbSecrets, DbType, MariaLimits, RedisLimits } from '../../lib/types.ts';
import { HttpError } from '../../lib/util.ts';

export const DEFAULT_BACKUP: BackupSchedule = { enabled: true, mode: 'daily', time: '04:00', intervalHours: 6, keep: 7 };

export const MARIA_DEFAULTS: MariaLimits = {
  maxConnections: 500,
  maxUserConnections: 0,
  maxConnectErrors: 100000,
  waitTimeout: 28800,
  maxAllowedPacketMB: 64,
  innodbBufferPoolMB: 256,
  tableOpenCache: 4000,
  threadCacheSize: 64,
};

/** '제한 해제' 버튼이 적용하는 값 */
export const MARIA_UNLIMITED: Partial<MariaLimits> = {
  maxConnections: 10000,
  maxUserConnections: 0,
  maxConnectErrors: 4294967295,
  maxAllowedPacketMB: 1024,
  tableOpenCache: 20000,
  threadCacheSize: 256,
};

export const REDIS_DEFAULTS: RedisLimits = {
  maxClients: 10000,
  maxMemoryMB: 0,
  maxMemoryPolicy: 'noeviction',
  timeout: 0,
  appendonly: true,
  save: '3600 1 300 100 60 10000',
};

export const REDIS_UNLIMITED: Partial<RedisLimits> = {
  maxClients: 100000,
  maxMemoryMB: 0,
  timeout: 0,
};

export function toDb(row: DbRow): Db {
  const { config, secrets_enc: _s, ...rest } = row;
  const c = JSON.parse(config) as DbConfig;
  const limitsDefault = row.type === 'mariadb' ? MARIA_DEFAULTS : REDIS_DEFAULTS;
  return {
    ...rest,
    config: {
      ...c,
      resources: { ...NO_LIMITS, ...c.resources },
      limits: { ...limitsDefault, ...c.limits } as MariaLimits | RedisLimits,
      backup: { ...DEFAULT_BACKUP, ...c.backup },
    },
  };
}

export function getDbRow(slug: string): DbRow {
  const row = q.get<DbRow>('SELECT * FROM databases WHERE slug = ?', slug);
  if (!row) throw new HttpError(404, `데이터베이스를 찾을 수 없습니다: ${slug}`);
  return row;
}

export const getDb = (slug: string) => toDb(getDbRow(slug));
export const getDbById = (id: number) => {
  const r = q.get<DbRow>('SELECT * FROM databases WHERE id = ?', id);
  return r ? toDb(r) : null;
};
export const listDbs = () => q.all<DbRow>('SELECT * FROM databases ORDER BY name COLLATE NOCASE').map(toDb);

export function dbSecrets(slug: string): DbSecrets {
  return decryptJSON<DbSecrets>(getDbRow(slug).secrets_enc, { adminPassword: '', appPassword: '' });
}

export function setDbSecrets(slug: string, s: DbSecrets) {
  q.run('UPDATE databases SET secrets_enc = ?, updated_at = ? WHERE slug = ?', encryptJSON(s), now(), slug);
}

export function saveConfig(slug: string, c: DbConfig) {
  q.run('UPDATE databases SET config = ?, updated_at = ? WHERE slug = ?', JSON.stringify(c), now(), slug);
}

export const dataDir = (slug: string) => path.join(dbDir(slug), 'data');
export const runDir = (slug: string) => `/run/hrone-db-${slug}`;
export const unitOf = (slug: string) => UNIT.db(slug);

/** IPv4 만 사용 (Redis 6 호환, IPv6 꺼진 환경에서도 안전) */
export function bindAddress(bind: string, _type: DbType) {
  if (bind === 'all') return '0.0.0.0';
  if (bind === 'local' || !bind) return '127.0.0.1';
  return bind;
}

export const DEFAULT_PORTS: Record<DbType, number> = { mariadb: 3306, redis: 6379 };
