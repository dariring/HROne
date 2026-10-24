import fs from 'node:fs';
import { audit, type Actor } from '../../lib/audit.ts';
import { encryptJSON, randomPassword } from '../../lib/crypto.ts';
import { now, q } from '../../lib/db.ts';
import { bus } from '../../lib/events.ts';
import { tryRun } from '../../lib/exec.ts';
import { errMsg } from '../../lib/log.ts';
import { dbDir } from '../../lib/paths.ts';
import { NO_LIMITS } from '../../lib/settings.ts';
import type { BackupSchedule, Db, DbConfig, DbSecrets, DbType, MariaLimits, RedisLimits, Resources } from '../../lib/types.ts';
import { assertSlug, clampInt, HttpError, KeyedMutex, rmrf } from '../../lib/util.ts';
import { listeningPorts, normalizeResources, usedPorts } from '../apps.ts';
import * as journal from '../journal.ts';
import { ensureMariadbAppArmor } from '../packages.ts';
import { startJob } from '../jobs.ts';
import * as systemd from '../systemd.ts';
import {
  DEFAULT_BACKUP,
  DEFAULT_PORTS,
  MARIA_DEFAULTS,
  MARIA_UNLIMITED,
  REDIS_DEFAULTS,
  REDIS_UNLIMITED,
  dbSecrets,
  getDb,
  saveConfig,
  setDbSecrets,
  unitOf,
} from './common.ts';
import { linksForDb } from './links.ts';
import * as maria from './mariadb.ts';
import * as redis from './redis.ts';

export * from './common.ts';
export const dbLock = new KeyedMutex();

async function allocateDbPort(type: DbType) {
  const used = usedPorts();
  const listening = await listeningPorts();
  const start = DEFAULT_PORTS[type];
  for (let p = start; p < start + 200; p++) if (!used.has(p) && !listening.has(p)) return p;
  throw new HttpError(409, '사용 가능한 포트가 없습니다');
}

export interface CreateDbInput {
  slug: string;
  name?: string;
  type: DbType;
  port?: number | null;
  bind?: string;
  autostart?: boolean;
  resources?: Partial<Resources>;
}

function str(v: unknown, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

export function normalizeBind(v: unknown) {
  const s = str(v, 64) || 'local';
  if (s === 'local' || s === 'all') return s;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  throw new HttpError(400, '바인드 주소는 local / all / IPv4 주소 중 하나여야 합니다');
}

export async function createDatabase(input: CreateDbInput, actor: Actor) {
  const slug = str(input.slug, 30).toLowerCase();
  assertSlug(slug);
  if (input.type !== 'mariadb' && input.type !== 'redis') throw new HttpError(400, '종류는 mariadb 또는 redis');
  if (q.get('SELECT 1 FROM databases WHERE slug = ?', slug)) throw new HttpError(409, `이미 있는 DB ID 입니다: ${slug}`);
  const port = input.port ? clampInt(input.port, 1024, 65535, 0) : await allocateDbPort(input.type);
  const conflict = usedPorts().get(port);
  if (conflict) throw new HttpError(409, `포트 ${port} 는 ${conflict} 가 사용 중입니다`);
  const resources = normalizeResources(input.resources ?? NO_LIMITS);
  const limits: MariaLimits | RedisLimits =
    input.type === 'mariadb'
      ? {
          ...MARIA_DEFAULTS,
          // 메모리 상한이 있으면 버퍼 풀을 그 절반으로
          innodbBufferPoolMB: resources.memoryMB ? Math.max(64, Math.floor(resources.memoryMB / 2)) : MARIA_DEFAULTS.innodbBufferPoolMB,
        }
      : { ...REDIS_DEFAULTS, maxMemoryMB: resources.memoryMB ? Math.floor(resources.memoryMB * 0.8) : 0 };
  const dbName = slug.replace(/-/g, '_');
  const config: DbConfig = {
    port,
    bind: normalizeBind(input.bind),
    autostart: input.autostart ?? true,
    resources,
    limits,
    backup: { ...DEFAULT_BACKUP },
    defaultDb: dbName,
    appUser: dbName,
    adminUser: 'admin',
  };
  const secrets: DbSecrets = { adminPassword: randomPassword(28), appPassword: randomPassword(28) };
  const t = now();
  q.run(
    `INSERT INTO databases (slug, name, type, config, secrets_enc, desired_state, initialized, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?)`,
    slug,
    str(input.name, 80) || slug,
    input.type,
    JSON.stringify(config),
    encryptJSON(secrets),
    t,
    t,
  );
  audit(actor, 'db.create', slug, { type: input.type, port });
  bus.publish('databases', { slug });
  const job = initialize(slug);
  return { db: getDb(slug), jobId: job.id };
}

/** 설치 + 초기화 (재시도 가능) */
export function initialize(slug: string) {
  const db = getDb(slug);
  return startJob('db-init', slug, `${db.type === 'mariadb' ? 'MariaDB' : 'Redis'} ${db.name} 준비`, (log) =>
    dbLock.run(slug, async () => {
      const cur = getDb(slug);
      const s = dbSecrets(slug);
      if (cur.type === 'mariadb') await maria.init(cur, s, log);
      else await redis.init(cur, s, log);
      await systemd.setEnabled(unitOf(slug), cur.config.autostart);
      q.run('UPDATE databases SET initialized = 1, updated_at = ? WHERE slug = ?', now(), slug);
      log('준비 완료');
      bus.publish('databases', { slug });
    }),
  );
}

export async function writeRuntime(db: Db) {
  const s = dbSecrets(db.slug);
  if (db.type === 'mariadb') {
    // 패널이 켜질 때마다 불리므로, 이미 있는 서버도 업데이트만으로 AppArmor 설정이 맞춰진다
    await ensureMariadbAppArmor();
    maria.writeConfig(db);
  }
  else await redis.writeConfig(db, s);
  const unit = db.type === 'mariadb' ? await maria.unitContent(db) : await redis.unitContent(db);
  if (systemd.writeUnit(unitOf(db.slug), unit)) await systemd.daemonReload();
}

export interface UpdateDbInput {
  name?: string;
  port?: number;
  bind?: string;
  autostart?: boolean;
  resources?: Partial<Resources>;
  backup?: Partial<BackupSchedule>;
}

export async function updateDatabase(slug: string, input: UpdateDbInput, actor: Actor) {
  return dbLock.run(slug, async () => {
    const db = getDb(slug);
    const c = { ...db.config };
    let restart = false;
    if (input.port !== undefined && input.port !== c.port) {
      const p = clampInt(input.port, 1024, 65535, c.port);
      const conflict = usedPorts().get(p);
      if (conflict && !conflict.endsWith(db.name)) throw new HttpError(409, `포트 ${p} 는 ${conflict} 가 사용 중입니다`);
      c.port = p;
      restart = true;
    }
    if (input.bind !== undefined) {
      const b = normalizeBind(input.bind);
      if (b !== c.bind) restart = true;
      c.bind = b;
    }
    if (input.autostart !== undefined) c.autostart = !!input.autostart;
    if (input.resources) c.resources = normalizeResources({ ...c.resources, ...input.resources });
    if (input.backup) {
      const b = { ...c.backup, ...input.backup };
      c.backup = {
        enabled: !!b.enabled,
        mode: b.mode === 'interval' ? 'interval' : 'daily',
        time: /^\d{2}:\d{2}$/.test(b.time) ? b.time : '04:00',
        intervalHours: clampInt(b.intervalHours, 1, 168, 6),
        keep: clampInt(b.keep, 1, 365, 7),
      };
    }
    const name = input.name !== undefined ? str(input.name, 80) || db.name : db.name;
    q.run('UPDATE databases SET name = ?, config = ?, updated_at = ? WHERE slug = ?', name, JSON.stringify(c), now(), slug);
    const next = getDb(slug);
    if (next.initialized) {
      await writeRuntime(next);
      await systemd.setEnabled(unitOf(slug), c.autostart);
      await systemd.applyResourcesLive(unitOf(slug), c.resources);
      if (restart && next.desired_state === 'running') {
        await journal.mark(unitOf(slug), `포트/바인드 변경으로 재시작 (${actor.username})`);
        await systemd.systemctl('restart', unitOf(slug));
      }
    }
    audit(actor, 'db.update', slug, input);
    bus.publish('databases', { slug });
    return { db: next, restarted: restart, linkedApps: linksForDb(db.id).map((l) => l.app_id) };
  });
}

export async function dbLifecycle(slug: string, action: 'start' | 'stop' | 'restart', actor: Actor) {
  return dbLock.run(`life:${slug}`, async () => {
    const db = getDb(slug);
    if (!db.initialized) throw new HttpError(409, '아직 초기화되지 않았습니다');
    const unit = unitOf(slug);
    if (action !== 'stop') {
      await writeRuntime(db);
      await tryRun('systemctl', ['reset-failed', unit]);
    }
    await journal.mark(unit, `${action === 'start' ? '▶ 시작' : action === 'stop' ? '■ 정지' : '↻ 재시작'} 요청 (${actor.username})`);
    await systemd.systemctl(action, unit);
    q.run('UPDATE databases SET desired_state = ?, updated_at = ? WHERE slug = ?', action === 'stop' ? 'stopped' : 'running', now(), slug);
    audit(actor, `db.${action}`, slug);
    bus.publish('databases', { slug });
  });
}

export async function updateLimits(slug: string, patch: Partial<MariaLimits & RedisLimits>, actor: Actor) {
  return dbLock.run(slug, async () => {
    const db = getDb(slug);
    const c = { ...db.config };
    if (db.type === 'mariadb') {
      const cur = c.limits as MariaLimits;
      const p = patch as Partial<MariaLimits>;
      c.limits = {
        maxConnections: clampInt(p.maxConnections ?? cur.maxConnections, 1, 100000, cur.maxConnections),
        maxUserConnections: clampInt(p.maxUserConnections ?? cur.maxUserConnections, 0, 100000, 0),
        maxConnectErrors: clampInt(p.maxConnectErrors ?? cur.maxConnectErrors, 1, 4294967295, cur.maxConnectErrors),
        waitTimeout: clampInt(p.waitTimeout ?? cur.waitTimeout, 1, 31536000, cur.waitTimeout),
        maxAllowedPacketMB: clampInt(p.maxAllowedPacketMB ?? cur.maxAllowedPacketMB, 1, 1024, cur.maxAllowedPacketMB),
        innodbBufferPoolMB: clampInt(p.innodbBufferPoolMB ?? cur.innodbBufferPoolMB, 16, 1024 * 1024, cur.innodbBufferPoolMB),
        tableOpenCache: clampInt(p.tableOpenCache ?? cur.tableOpenCache, 1, 1000000, cur.tableOpenCache),
        threadCacheSize: clampInt(p.threadCacheSize ?? cur.threadCacheSize, 0, 16384, cur.threadCacheSize),
      };
    } else {
      const cur = c.limits as RedisLimits;
      const p = patch as Partial<RedisLimits>;
      const policies = ['noeviction', 'allkeys-lru', 'allkeys-lfu', 'allkeys-random', 'volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl'];
      c.limits = {
        maxClients: clampInt(p.maxClients ?? cur.maxClients, 1, 1000000, cur.maxClients),
        maxMemoryMB: clampInt(p.maxMemoryMB ?? cur.maxMemoryMB, 0, 1024 * 1024, cur.maxMemoryMB),
        maxMemoryPolicy: policies.includes(String(p.maxMemoryPolicy)) ? String(p.maxMemoryPolicy) : cur.maxMemoryPolicy,
        timeout: clampInt(p.timeout ?? cur.timeout, 0, 31536000, cur.timeout),
        appendonly: p.appendonly === undefined ? cur.appendonly : !!p.appendonly,
        save: p.save === undefined ? cur.save : String(p.save).replace(/[^\d\s]/g, '').trim(),
      };
    }
    saveConfig(slug, c);
    const next = getDb(slug);
    let warnings: string[] = [];
    if (next.initialized) {
      await writeRuntime(next);
      const active = (await tryRun('systemctl', ['is-active', unitOf(slug)])).stdout.trim() === 'active';
      if (active) {
        warnings = next.type === 'mariadb' ? await maria.applyLimitsLive(next) : await redis.applyLimitsLive(next, dbSecrets(slug));
      }
    }
    audit(actor, 'db.limits', slug, patch);
    bus.publish('databases', { slug });
    return { db: next, warnings };
  });
}

export function unlimit(slug: string, actor: Actor) {
  const db = getDb(slug);
  return updateLimits(slug, db.type === 'mariadb' ? MARIA_UNLIMITED : REDIS_UNLIMITED, actor);
}

export async function dbStatus(slug: string) {
  const db = getDb(slug);
  if (!db.initialized) return null;
  const active = (await tryRun('systemctl', ['is-active', unitOf(slug)])).stdout.trim() === 'active';
  if (!active) return null;
  try {
    return db.type === 'mariadb' ? await maria.status(db) : await redis.status(db, dbSecrets(slug));
  } catch (e) {
    return { error: errMsg(e) };
  }
}

export async function rotatePassword(slug: string, which: 'admin' | 'app', actor: Actor) {
  return dbLock.run(slug, async () => {
    const db = getDb(slug);
    const old = dbSecrets(slug);
    const next: DbSecrets = { ...old };
    if (which === 'admin' || db.type === 'redis') next.adminPassword = randomPassword(28);
    if (which === 'app' && db.type === 'mariadb') next.appPassword = randomPassword(28);
    if (db.type === 'mariadb') await maria.setPasswords(db, next);
    else await redis.setPassword(db, old, next);
    setDbSecrets(slug, next);
    audit(actor, 'db.password', slug, { which });
    return { linkedApps: linksForDb(db.id).map((l) => l.app_id) };
  });
}

export async function terminateDatabase(slug: string, actor: Actor, makeBackup: ((db: Db) => Promise<string | null>) | null) {
  return dbLock.run(slug, async () => {
    const db = getDb(slug);
    let backupFile: string | null = null;
    if (makeBackup && db.initialized) {
      const active = (await tryRun('systemctl', ['is-active', unitOf(slug)])).stdout.trim() === 'active';
      if (active) {
        try {
          backupFile = await makeBackup(db);
        } catch (e) {
          throw new HttpError(500, `최종 백업에 실패해 삭제를 중단했습니다: ${errMsg(e)}`);
        }
      }
    }
    const linked = linksForDb(db.id).map((l) => l.app_id);
    await systemd.removeUnit(unitOf(slug));
    rmrf(dbDir(slug));
    q.run('DELETE FROM databases WHERE id = ?', db.id);
    audit(actor, 'db.terminate', slug, { backup: backupFile });
    bus.publish('databases', { slug, deleted: true });
    return { backupFile, linkedApps: linked };
  });
}

export function dbEngine(db: Db) {
  return db.type === 'mariadb' ? 'mariadb' : 'redis';
}

export function dataExists(slug: string) {
  return fs.existsSync(dbDir(slug));
}

export { maria, redis };
