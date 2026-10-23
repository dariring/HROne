import { q } from '../../lib/db.ts';
import type { EnvVar } from '../../lib/types.ts';
import { dbSecrets, getDbById, unitOf } from './common.ts';

export interface LinkRow {
  app_id: number;
  database_id: number;
  prefix: string;
}

export function linksForApp(appId: number) {
  return q.all<LinkRow>('SELECT * FROM app_links WHERE app_id = ?', appId);
}

export function linksForDb(dbId: number) {
  return q.all<LinkRow>('SELECT * FROM app_links WHERE database_id = ?', dbId);
}

/** 연결된 DB 의 접속 정보를 환경변수로 */
export function connectionEnv(dbId: number, prefix = ''): EnvVar[] {
  const db = getDbById(dbId);
  if (!db) return [];
  const s = dbSecrets(db.slug);
  const p = prefix.toUpperCase();
  const host = '127.0.0.1';
  const port = String(db.config.port);
  if (db.type === 'mariadb') {
    const user = db.config.appUser;
    const pass = s.appPassword;
    const name = db.config.defaultDb;
    return [
      { key: `${p}DB_HOST`, value: host },
      { key: `${p}DB_PORT`, value: port },
      { key: `${p}DB_USER`, value: user },
      { key: `${p}DB_PASSWORD`, value: pass },
      { key: `${p}DB_NAME`, value: name },
      { key: `${p}DATABASE_URL`, value: `mysql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${name}` },
    ];
  }
  return [
    { key: `${p}REDIS_HOST`, value: host },
    { key: `${p}REDIS_PORT`, value: port },
    { key: `${p}REDIS_PASSWORD`, value: s.adminPassword },
    { key: `${p}REDIS_URL`, value: `redis://:${encodeURIComponent(s.adminPassword)}@${host}:${port}/0` },
  ];
}

export function linkedEnvFor(appId: number): EnvVar[] {
  return linksForApp(appId).flatMap((l) => connectionEnv(l.database_id, l.prefix));
}

export function linkedUnitsFor(appId: number): string[] {
  return linksForApp(appId)
    .map((l) => getDbById(l.database_id))
    .filter((d) => !!d)
    .map((d) => unitOf(d!.slug));
}
