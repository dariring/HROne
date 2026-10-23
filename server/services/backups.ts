import fs from 'node:fs';
import path from 'node:path';
import { audit, SYSTEM, type Actor } from '../lib/audit.ts';
import { now, q } from '../lib/db.ts';
import { bus } from '../lib/events.ts';
import { run } from '../lib/exec.ts';
import { errMsg, log } from '../lib/log.ts';
import { appDir, PATHS } from '../lib/paths.ts';
import type { App, BackupRow, BackupSchedule, Db } from '../lib/types.ts';
import { HttpError } from '../lib/util.ts';
import { appIdentity, getApp, getEnv, gitAuthFor, listApps, workDir } from './apps.ts';
import { dbLock, dbSecrets, getDb, listDbs, maria, redis } from './databases/index.ts';
import * as git from './git.ts';
import { startJob } from './jobs.ts';
import { notify } from './notify.ts';

/** 서버 시간대 기준 YYYYMMDD-HHMMSS */
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function targetDir(kind: 'database' | 'app', slug: string) {
  const d = path.join(PATHS.backups, kind === 'app' ? 'apps' : 'databases', slug);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function record(kind: BackupRow['kind'], slug: string, file: string, trigger: BackupRow['trigger'], note = '') {
  const r = q.run(
    `INSERT INTO backups (kind, target_slug, file, size, trigger, status, note, created_at) VALUES (?, ?, ?, 0, ?, 'running', ?, ?)`,
    kind,
    slug,
    file,
    trigger,
    note,
    now(),
  );
  return Number(r.lastInsertRowid);
}

function finish(id: number, file: string, ok: boolean, note?: string) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* 없음 */
  }
  q.run('UPDATE backups SET status = ?, size = ?, note = COALESCE(?, note) WHERE id = ?', ok ? 'done' : 'failed', size, note ?? null, id);
  bus.publish('backups', { id });
}

// ---------- DB ----------

export async function backupDatabase(db: Db, trigger: BackupRow['trigger'], note = '') {
  const ext = db.type === 'mariadb' ? 'sql.gz' : 'rdb.gz';
  const file = path.join(targetDir('database', db.slug), `${db.slug}-${stamp()}-${trigger}.${ext}`);
  const id = record('database', db.slug, file, trigger, note);
  try {
    if (db.type === 'mariadb') await maria.backup(db, file);
    else await redis.backup(db, dbSecrets(db.slug), file);
    fs.chmodSync(file, 0o600);
    finish(id, file, true);
    return file;
  } catch (e) {
    fs.rmSync(file, { force: true });
    finish(id, file, false, errMsg(e));
    throw e;
  }
}

export function restoreDatabase(slug: string, backupId: number, actor: Actor) {
  const b = getBackup(backupId);
  if (b.kind !== 'database' || b.target_slug !== slug) throw new HttpError(400, '이 DB 의 백업이 아닙니다');
  if (!fs.existsSync(b.file)) throw new HttpError(404, '백업 파일이 없습니다');
  const db = getDb(slug);
  return startJob('db-restore', slug, `${db.name} 복원`, (log) =>
    dbLock.run(slug, async () => {
      log('복원 전에 현재 상태를 백업합니다...');
      await backupDatabase(getDb(slug), 'manual', `복원 전 자동 백업 (#${backupId})`).catch((e) => log(`복원 전 백업 실패 (계속 진행): ${errMsg(e)}`));
      if (db.type === 'mariadb') await maria.restore(getDb(slug), b.file, log);
      else await redis.restore(getDb(slug), dbSecrets(slug), b.file, log);
      audit(actor, 'db.restore', slug, { backupId });
      log('복원 완료');
    }),
  );
}

// ---------- 앱 데이터 ----------

/** 보존 경로(데이터 파일) + 환경변수를 tar.gz 로 */
export async function backupAppData(app: App, trigger: BackupRow['trigger'], full = false) {
  const file = path.join(targetDir('app', app.slug), `${app.slug}-${stamp()}-${trigger}.tar.gz`);
  const id = record('app', app.slug, file, trigger, full ? '전체 폴더' : '데이터(보존 경로)');
  const tmp = fs.mkdtempSync(path.join(PATHS.tmp, 'bk-'));
  try {
    const root = appDir(app.slug);
    fs.writeFileSync(path.join(tmp, 'hrone-env.json'), JSON.stringify({ app: app.slug, config: app.config, env: getEnv(app.slug) }, null, 2), {
      mode: 0o600,
    });
    const list = path.join(tmp, 'files.txt');
    if (full) {
      await run('tar', ['-czf', file, '--exclude=node_modules', '--exclude=.venv', '-C', path.dirname(root), path.basename(root), '-C', tmp, 'hrone-env.json']);
    } else {
      let files: string[] = [];
      if (fs.existsSync(path.join(root, '.git'))) {
        const ctx = { id: appIdentity(app), auth: gitAuthFor(app) };
        files = (await git.filesMatching(workDir(app), app.config.preservePaths, ctx)).filter((f) => !f.includes('node_modules/'));
        const prefix = app.config.rootDir ? app.config.rootDir + '/' : '';
        files = files.map((f) => prefix + f).filter((f) => fs.existsSync(path.join(root, f)));
      }
      fs.writeFileSync(list, files.join('\n') + (files.length ? '\n' : ''));
      await run('tar', ['-czf', file, '-C', root, '--files-from', list, '-C', tmp, 'hrone-env.json']);
    }
    fs.chmodSync(file, 0o600);
    finish(id, file, true);
    return file;
  } catch (e) {
    fs.rmSync(file, { force: true });
    finish(id, file, false, errMsg(e));
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function restoreAppData(slug: string, backupId: number, actor: Actor) {
  const b = getBackup(backupId);
  if (b.kind !== 'app' || b.target_slug !== slug) throw new HttpError(400, '이 앱의 백업이 아닙니다');
  const app = getApp(slug);
  return startJob('app-restore', slug, `${app.name} 데이터 복원`, async (log) => {
    const id = appIdentity(app);
    log('복원 전에 현재 데이터를 백업합니다...');
    await backupAppData(app, 'manual').catch((e) => log(`복원 전 백업 실패 (계속 진행): ${errMsg(e)}`));
    const root = appDir(slug);
    const full = (b.note ?? '').includes('전체');
    if (full) {
      await run('tar', ['-xzf', b.file, '-C', path.dirname(root), '--exclude=hrone-env.json', '--no-same-owner']);
    } else {
      await run('tar', ['-xzf', b.file, '-C', root, '--exclude=hrone-env.json', '--no-same-owner']);
    }
    await run('chown', ['-R', `${id.uid}:${id.gid}`, root]);
    audit(actor, 'app.restore', slug, { backupId });
    log('복원 완료. 앱을 재시작하면 반영됩니다.');
  });
}

// ---------- 공통 ----------

export function getBackup(id: number) {
  const b = q.get<BackupRow>('SELECT * FROM backups WHERE id = ?', id);
  if (!b) throw new HttpError(404, '백업을 찾을 수 없습니다');
  return b;
}

export function listBackups(kind?: BackupRow['kind'], slug?: string) {
  if (kind && slug) return q.all<BackupRow>('SELECT * FROM backups WHERE kind = ? AND target_slug = ? ORDER BY id DESC LIMIT 500', kind, slug);
  return q.all<BackupRow>('SELECT * FROM backups ORDER BY id DESC LIMIT 1000');
}

export function deleteBackup(id: number, actor: Actor) {
  const b = getBackup(id);
  if (!b.file.startsWith(PATHS.backups + path.sep)) throw new HttpError(400, '백업 폴더 밖의 파일입니다');
  fs.rmSync(b.file, { force: true });
  q.run('DELETE FROM backups WHERE id = ?', id);
  audit(actor, 'backup.delete', b.target_slug, { id, file: path.basename(b.file) });
  bus.publish('backups', { id });
}

function prune(kind: BackupRow['kind'], slug: string, keep: number) {
  const rows = q.all<BackupRow>(
    `SELECT * FROM backups WHERE kind = ? AND target_slug = ? AND trigger = 'schedule' AND status = 'done' ORDER BY id DESC`,
    kind,
    slug,
  );
  for (const r of rows.slice(keep)) {
    fs.rmSync(r.file, { force: true });
    q.run('DELETE FROM backups WHERE id = ?', r.id);
  }
}

/** 예약 백업이 지금 실행돼야 하는지 */
export function isDue(s: BackupSchedule, lastAt: number | null, at = new Date()) {
  if (!s.enabled) return false;
  if (s.mode === 'interval') return !lastAt || at.getTime() - lastAt >= s.intervalHours * 3600_000 - 30_000;
  const [hh, mm] = s.time.split(':').map(Number);
  const today = new Date(at);
  today.setHours(hh ?? 4, mm ?? 0, 0, 0);
  if (at < today) return false;
  return !lastAt || lastAt < today.getTime();
}

function lastScheduled(kind: BackupRow['kind'], slug: string) {
  return (
    q.get<{ t: number }>(`SELECT MAX(created_at) t FROM backups WHERE kind = ? AND target_slug = ? AND trigger = 'schedule'`, kind, slug)?.t ?? null
  );
}

let running = false;

export async function scheduledTick() {
  if (running) return;
  running = true;
  try {
    for (const db of listDbs()) {
      if (!db.initialized || db.desired_state !== 'running') continue;
      if (!isDue(db.config.backup, lastScheduled('database', db.slug))) continue;
      try {
        await dbLock.run(db.slug, () => backupDatabase(db, 'schedule'));
        prune('database', db.slug, db.config.backup.keep);
      } catch (e) {
        log.warn(`scheduled backup ${db.slug} failed: ${errMsg(e)}`);
        await notify({ kind: 'backup_failed', title: `DB 백업 실패: ${db.name}`, description: errMsg(e), color: 'red' });
      }
    }
    for (const app of listApps()) {
      const s = app.config.backup;
      if (!s || !app.deployed_sha) continue;
      if (!isDue(s, lastScheduled('app', app.slug))) continue;
      try {
        await backupAppData(app, 'schedule');
        prune('app', app.slug, s.keep);
      } catch (e) {
        log.warn(`scheduled app backup ${app.slug} failed: ${errMsg(e)}`);
        await notify({ kind: 'backup_failed', app, title: `앱 데이터 백업 실패: ${app.name}`, description: errMsg(e), color: 'red' });
      }
    }
  } finally {
    running = false;
  }
}

export function backupActor() {
  return SYSTEM;
}
