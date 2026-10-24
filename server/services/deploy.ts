import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { audit, SYSTEM, type Actor } from '../lib/audit.ts';
import { now, q } from '../lib/db.ts';
import { bus } from '../lib/events.ts';
import { run, tryRun } from '../lib/exec.ts';
import { errMsg, log as plog } from '../lib/log.ts';
import { appDataDir, appDir, PATHS, UNIT } from '../lib/paths.ts';
import type { App, Commit, DeployRow, DeployStatus, DeployTrigger } from '../lib/types.ts';
import { HttpError, rmrf, shortSha, sleep } from '../lib/util.ts';
import {
  appIdentity,
  buildEnv,
  ensureAppIdentity,
  getApp,
  getAppById,
  gitAuthFor,
  venvDir,
  workDir,
  writeRuntime,
} from './apps.ts';
import { detect, manifestFiles, nodeInstallCmd, pythonInstallCmd } from './detect.ts';
import { keepUnpushed } from './appgit.ts';
import * as git from './git.ts';
import * as journal from './journal.ts';
import { notify } from './notify.ts';
import { ensureNode, ensurePython, ensureUv, pyEnv } from './runtimes.ts';
import * as systemd from './systemd.ts';
import type { Identity } from './users.ts';

export interface Deploy extends Omit<DeployRow, 'commits'> {
  commits: Commit[];
}

const OPEN: DeployStatus[] = ['pending', 'scheduled', 'queued'];

export function toDeploy(r: DeployRow): Deploy {
  return { ...r, commits: JSON.parse(r.commits || '[]') as Commit[] };
}

export function getDeploy(id: number) {
  const r = q.get<DeployRow>('SELECT * FROM deploys WHERE id = ?', id);
  if (!r) throw new HttpError(404, '배포 기록을 찾을 수 없습니다');
  return toDeploy(r);
}

export function listDeploys(appId: number, limit = 50) {
  return q.all<DeployRow>('SELECT * FROM deploys WHERE app_id = ? ORDER BY id DESC LIMIT ?', appId, limit).map(toDeploy);
}

export function openDeploys() {
  return q
    .all<DeployRow>(`SELECT * FROM deploys WHERE status IN ('pending','scheduled','queued','running') ORDER BY id`)
    .map(toDeploy);
}

export function recentDeploys(limit = 20) {
  return q.all<DeployRow>('SELECT * FROM deploys ORDER BY id DESC LIMIT ?', limit).map(toDeploy);
}

function openFor(appId: number) {
  const r = q.get<DeployRow>(
    `SELECT * FROM deploys WHERE app_id = ? AND status IN ('pending','scheduled','queued') ORDER BY id DESC LIMIT 1`,
    appId,
  );
  return r ? toDeploy(r) : null;
}

function setStatus(id: number, status: DeployStatus, extra: Partial<Record<keyof DeployRow, string | number | null>> = {}) {
  const sets = ['status = ?'];
  const vals: (string | number | null)[] = [status];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  q.run(`UPDATE deploys SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  publish(id);
}

function publish(id: number) {
  const d = getDeploy(id);
  bus.publish('deploys', d);
}

export const logPath = (id: number) => path.join(PATHS.deployLogs, `${id}.log`);

export function readLog(id: number) {
  try {
    return fs.readFileSync(logPath(id), 'utf8');
  } catch {
    return '';
  }
}

// ---------- 새 커밋 감지 ----------

function ctxFor(app: App) {
  return { id: appIdentity(app), auth: gitAuthFor(app) };
}

const MODE_TEXT = (app: App) =>
  app.config.deployMode === 'auto'
    ? '즉시 자동 적용'
    : app.config.deployMode === 'delay'
      ? `${fmtDelay(app.config.deployDelaySec)} 뒤 자동 적용`
      : '검토 후 승인 필요';

export function fmtDelay(sec: number) {
  if (sec < 60) return `${sec}초`;
  if (sec < 3600) return `${Math.round(sec / 60)}분`;
  return `${Math.round((sec / 3600) * 10) / 10}시간`;
}

async function commitsBetween(app: App, from: string | null, to: string): Promise<{ commits: Commit[]; files: string[] }> {
  const root = appDir(app.slug);
  if (!fs.existsSync(path.join(root, '.git'))) return { commits: [], files: [] };
  const ctx = ctxFor(app);
  const commits = await git.log(root, from, to, ctx, 30).catch(() => []);
  const files = from ? await git.diffNames(root, from, to, ctx).catch(() => []) : [];
  return { commits, files };
}

/** 폴링/웹후크가 원격 브랜치의 새 sha 를 발견했을 때 */
export async function onRemoteUpdate(app: App, sha: string, source: 'push' | 'webhook') {
  q.run('UPDATE apps SET last_seen_sha = ? WHERE id = ?', sha, app.id);
  if (sha === app.deployed_sha || sha === app.rejected_sha) return;
  if (!app.deployed_sha) return; // 첫 배포 전에는 자동으로 하지 않는다
  const open = openFor(app.id);
  if (open && open.to_sha === sha) return;
  const running = q.get<DeployRow>(`SELECT * FROM deploys WHERE app_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`, app.id);
  if (running && running.to_sha === sha) return;

  const root = appDir(app.slug);
  const ctx = ctxFor(app);
  try {
    if (fs.existsSync(path.join(root, '.git'))) await git.fetch(root, app.config.repoUrl, app.config.branch, ctx);
  } catch (e) {
    plog.warn(`fetch ${app.slug}: ${errMsg(e)}`);
  }
  const { commits, files } = await commitsBetween(app, app.deployed_sha, sha);

  if (app.config.watchPaths.length && files.length) {
    const scoped = scopePatterns(app.config.watchPaths, app.config.rootDir);
    if (!files.some((f) => git.matchesAny(f, scoped))) {
      const id = insertDeploy(app, source, 'superseded', sha, commits, null);
      q.run('UPDATE deploys SET error = ?, finished_at = ? WHERE id = ?', '감시 경로 밖의 변경이라 건너뜀', now(), id);
      publish(id);
      return;
    }
  }

  const mode = app.config.deployMode;
  const scheduledAt = mode === 'delay' ? now() + app.config.deployDelaySec * 1000 : null;
  let id: number;
  if (open && open.status !== 'queued') {
    // 아직 적용 전인 배포가 있으면 최신 커밋으로 갈아탄다 (지연 모드는 타이머도 다시)
    id = open.id;
    q.run(
      'UPDATE deploys SET to_sha = ?, commits = ?, scheduled_at = COALESCE(?, scheduled_at), trigger = ? WHERE id = ?',
      sha,
      JSON.stringify(commits),
      scheduledAt,
      source,
      id,
    );
    publish(id);
  } else {
    const status: DeployStatus = mode === 'auto' ? 'queued' : mode === 'delay' ? 'scheduled' : 'pending';
    id = insertDeploy(app, source, status, sha, commits, scheduledAt);
    if (status === 'queued') enqueue(id);
  }

  const list = commits
    .slice(0, 8)
    .map((c) => `\`${c.sha.slice(0, 7)}\` ${c.message.slice(0, 80)} — ${c.author}`)
    .join('\n');
  await notify({
    kind: mode === 'manual' ? 'pending' : 'push',
    app,
    title: mode === 'manual' ? `🔍 ${app.name}: 새 푸시 — 승인 대기` : `📥 ${app.name}: 새 푸시 감지`,
    description: `${list || shortSha(sha)}${commits.length > 8 ? `\n외 ${commits.length - 8}개` : ''}`,
    color: mode === 'manual' ? 'yellow' : 'blue',
    fields: [
      { name: '브랜치', value: app.config.branch, inline: true },
      { name: '적용 방식', value: MODE_TEXT(app), inline: true },
    ],
    path: `/apps/${app.slug}?tab=deploys`,
  });
}

function insertDeploy(app: App, trigger: DeployTrigger, status: DeployStatus, sha: string | null, commits: Commit[], scheduledAt: number | null, by?: string) {
  const r = q.run(
    `INSERT INTO deploys (app_id, trigger, status, from_sha, to_sha, commits, scheduled_at, created_at, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    app.id,
    trigger,
    status,
    app.deployed_sha,
    sha,
    JSON.stringify(commits),
    scheduledAt,
    now(),
    by ?? null,
  );
  const id = Number(r.lastInsertRowid);
  publish(id);
  return id;
}

/** 수동 배포 / 첫 배포 / 롤백 */
export async function requestDeploy(slug: string, opts: { trigger: DeployTrigger; sha?: string | null; actor: Actor }) {
  const app = getApp(slug);
  const open = openFor(app.id);
  if (open) setStatus(open.id, 'superseded', { finished_at: now(), error: '새 배포 요청으로 대체됨' });
  let commits: Commit[] = [];
  if (opts.sha) commits = (await commitsBetween(app, app.deployed_sha, opts.sha)).commits;
  const id = insertDeploy(app, opts.trigger, 'queued', opts.sha ?? null, commits, null, opts.actor.username);
  audit(opts.actor, `deploy.${opts.trigger}`, slug, { id, sha: opts.sha ?? 'latest' });
  enqueue(id);
  return id;
}

export function approve(id: number, actor: Actor) {
  const d = getDeploy(id);
  if (d.status !== 'pending' && d.status !== 'scheduled') throw new HttpError(409, '승인할 수 있는 상태가 아닙니다');
  setStatus(id, 'queued', { approved_by: actor.username });
  audit(actor, 'deploy.approve', String(d.app_id), { id });
  enqueue(id);
}

export function reject(id: number, actor: Actor) {
  const d = getDeploy(id);
  if (!OPEN.includes(d.status)) throw new HttpError(409, '거절/취소할 수 있는 상태가 아닙니다 (이미 실행 중이거나 끝났습니다)');
  dequeue(id);
  setStatus(id, d.status === 'pending' ? 'rejected' : 'cancelled', { finished_at: now(), approved_by: actor.username });
  if (d.to_sha) q.run('UPDATE apps SET rejected_sha = ? WHERE id = ?', d.to_sha, d.app_id);
  audit(actor, d.status === 'pending' ? 'deploy.reject' : 'deploy.cancel', String(d.app_id), { id });
}

// ---------- 실행 큐 ----------

const MAX_CONCURRENT = 2;
const waiting: number[] = [];
const busyApps = new Set<number>();
let active = 0;

function enqueue(id: number) {
  if (!waiting.includes(id)) waiting.push(id);
  pump();
}

function dequeue(id: number) {
  const i = waiting.indexOf(id);
  if (i >= 0) waiting.splice(i, 1);
}

function pump() {
  while (active < MAX_CONCURRENT) {
    const idx = waiting.findIndex((id) => {
      const r = q.get<DeployRow>('SELECT app_id FROM deploys WHERE id = ?', id);
      return r && !busyApps.has(r.app_id);
    });
    if (idx < 0) return;
    const id = waiting.splice(idx, 1)[0]!;
    const row = q.get<DeployRow>('SELECT * FROM deploys WHERE id = ?', id);
    if (!row || row.status !== 'queued') continue;
    active++;
    busyApps.add(row.app_id);
    execute(id)
      .catch((e) => plog.error(`deploy ${id}: ${errMsg(e)}`))
      .finally(() => {
        active--;
        busyApps.delete(row.app_id);
        pump();
      });
  }
}

export function isAppBusy(appId: number) {
  return busyApps.has(appId);
}

/** 지연 배포 시간 도래 + 재시작 후 복구 */
export function schedulerTick() {
  const due = q.all<DeployRow>(`SELECT * FROM deploys WHERE status = 'scheduled' AND scheduled_at <= ?`, now());
  for (const d of due) {
    setStatus(d.id, 'queued');
    enqueue(d.id);
  }
}

export function recoverOnBoot() {
  for (const d of q.all<DeployRow>(`SELECT * FROM deploys WHERE status = 'running'`)) {
    setStatus(d.id, 'failed', { finished_at: now(), error: '패널이 재시작되어 배포가 중단되었습니다' });
  }
  for (const d of q.all<DeployRow>(`SELECT * FROM deploys WHERE status = 'queued' ORDER BY id`)) enqueue(d.id);
}

// ---------- 배포 실행 ----------

type Log = (line: string) => void;

function makeLogger(id: number) {
  fs.mkdirSync(PATHS.deployLogs, { recursive: true });
  const fd = fs.openSync(logPath(id), 'a', 0o600);
  const logger: Log & { close: () => void } = Object.assign(
    (line: string) => {
      const clean = line.replace(/\r/g, '');
      try {
        fs.writeSync(fd, clean + '\n');
      } catch {
        /* noop */
      }
      bus.publish(`deploy:${id}`, { line: clean });
    },
    { close: () => fs.closeSync(fd) },
  );
  return logger;
}

async function execute(id: number) {
  const d = getDeploy(id);
  const app = getAppById(d.app_id);
  if (!app) return;
  const log = makeLogger(id);
  const unit = UNIT.app(app.slug);
  const started = now();
  setStatus(id, 'running', { started_at: started, from_sha: app.deployed_sha });
  const prevSha = app.deployed_sha;
  let changedTree = false;
  try {
    log(`▶ 배포 #${id} 시작 — ${app.name} (${app.config.branch})`);
    await journal.mark(unit, `⇪ 배포 #${id} 시작`);
    if (app.config.notify.start) {
      await notify({ kind: 'start', app, title: `🚀 ${app.name}: 배포 시작`, color: 'gray', path: `/apps/${app.slug}?tab=deploys` });
    }
    const result = await pipeline(app, d, log, () => {
      changedTree = true;
    });
    const dur = Math.round((now() - started) / 1000);
    q.run('UPDATE apps SET deployed_sha = ?, deployed_at = ?, last_seen_sha = COALESCE(last_seen_sha, ?) WHERE id = ?', result.sha, now(), result.sha, app.id);
    if (d.trigger === 'rollback' && result.remoteSha && result.remoteSha !== result.sha) {
      q.run('UPDATE apps SET rejected_sha = ? WHERE id = ?', result.remoteSha, app.id);
      log(`롤백했으므로 원격 최신 커밋 ${shortSha(result.remoteSha)} 은 새 푸시가 올 때까지 자동 배포하지 않습니다.`);
    }
    setStatus(id, 'success', { finished_at: now(), to_sha: result.sha });
    log(`✔ 배포 완료 (${dur}초)`);
    await journal.mark(unit, `✔ 배포 #${id} 완료 → ${shortSha(result.sha)}`);
    const head = getDeploy(id).commits[0];
    await notify({
      kind: 'success',
      app,
      title: `✅ ${app.name}: 배포 완료`,
      description: head ? `\`${head.sha.slice(0, 7)}\` ${head.message}` : shortSha(result.sha),
      color: 'green',
      fields: [
        { name: '소요 시간', value: `${dur}초`, inline: true },
        { name: '방식', value: triggerText(d.trigger), inline: true },
      ],
      path: `/apps/${app.slug}?tab=deploys`,
    });
  } catch (e) {
    const msg = errMsg(e);
    log(`✖ 배포 실패: ${msg}`);
    await journal.mark(unit, `✖ 배포 #${id} 실패: ${msg.split('\n')[0]}`, 3);
    let status: DeployStatus = 'failed';
    let rollbackNote = '';
    const fresh = getApp(app.slug);
    if (fresh.config.autoRollback && prevSha && changedTree && d.trigger !== 'rollback') {
      log('');
      log(`↩ 자동 롤백: ${shortSha(prevSha)} 로 되돌립니다...`);
      try {
        await pipeline(fresh, { ...d, to_sha: prevSha }, log, () => {}, { noFetch: true });
        status = 'rolled_back';
        rollbackNote = `이전 버전 ${shortSha(prevSha)} 으로 롤백됨`;
        log(`✔ 롤백 완료`);
        await journal.mark(unit, `↩ 롤백 완료 → ${shortSha(prevSha)}`, 4);
      } catch (re) {
        rollbackNote = `롤백도 실패: ${errMsg(re)}`;
        log(`✖ ${rollbackNote}`);
      }
    }
    // 같은 커밋으로 계속 재시도하지 않게
    if (d.to_sha && d.trigger !== 'manual') q.run('UPDATE apps SET rejected_sha = ? WHERE id = ?', d.to_sha, app.id);
    setStatus(id, status, { finished_at: now(), error: [msg.split('\n')[0], rollbackNote].filter(Boolean).join(' / ') });
    await notify({
      kind: 'failure',
      app,
      title: `❌ ${app.name}: 배포 실패${status === 'rolled_back' ? ' (롤백됨)' : ''}`,
      description: '```\n' + msg.slice(-1500) + '\n```' + (rollbackNote ? `\n${rollbackNote}` : ''),
      color: 'red',
      path: `/apps/${app.slug}?tab=deploys`,
    });
  } finally {
    log.close();
    pruneDeployBackups(app.slug);
  }
}

function triggerText(t: DeployTrigger) {
  return { push: '푸시 감지', webhook: '웹후크', manual: '수동', rollback: '롤백', initial: '첫 배포', config: '설정 변경' }[t];
}

interface PipelineOpts {
  noFetch?: boolean;
}

/** 실제 배포 단계. 성공 시 배포된 sha 를 돌려준다 */
async function pipeline(app: App, d: Deploy, log: Log, onTreeChange: () => void, opts: PipelineOpts = {}) {
  const id = await ensureAppIdentity(app);
  const root = appDir(app.slug);
  const ctx = { id, auth: gitAuthFor(app) };
  const gitLog: Log = (l) => l.trim() && log(`  ${l}`);
  fs.mkdirSync(root, { recursive: true });
  fs.chownSync(root, id.uid, id.gid);

  // 1. 저장소 준비
  log('');
  log('━━ 1/6 소스 가져오기');
  if (!fs.existsSync(path.join(root, '.git'))) {
    const empty = fs.readdirSync(root).length === 0;
    if (empty) {
      log(`git clone ${app.config.repoUrl} (${app.config.branch})`);
      await git.clone(app.config.repoUrl, app.config.branch, root, { ...ctx, onLine: gitLog });
    } else {
      log('폴더에 기존 파일이 있어 그 자리에서 git 저장소로 연결합니다 (기존 파일 보존)');
      await git.git(['init', '-q', '-b', app.config.branch], { ...ctx, cwd: root });
      await git.git(['remote', 'add', 'origin', app.config.repoUrl], { ...ctx, cwd: root }).catch(() => {});
    }
  }
  let remoteSha: string | null = null;
  if (!opts.noFetch) {
    log(`git fetch origin ${app.config.branch}`);
    remoteSha = await git.fetch(root, app.config.repoUrl, app.config.branch, { ...ctx, onLine: gitLog });
  }
  const target = d.to_sha ?? remoteSha;
  if (!target) throw new Error('배포할 커밋을 정하지 못했습니다');
  if (!(await git.hasCommit(root, target, ctx))) throw new Error(`커밋 ${shortSha(target)} 을 찾을 수 없습니다 (force push 로 사라졌을 수 있습니다)`);
  if (!d.to_sha) {
    const commits = await git.log(root, app.deployed_sha, target, ctx, 30).catch(() => []);
    q.run('UPDATE deploys SET to_sha = ?, commits = ? WHERE id = ?', target, JSON.stringify(commits), d.id);
    publish(d.id);
  }
  const head = await git.headSha(root, ctx);
  log(`대상 커밋: ${shortSha(target)}${head ? ` (현재 ${shortSha(head)})` : ''}`);

  // 2. 로컬 데이터를 지키면서 작업 트리 갱신
  log('');
  log('━━ 2/6 코드 반영 (로컬 데이터 보존)');
  const modified = head ? await git.locallyModified(root, ctx).catch(() => [] as string[]) : [];
  // 패널에서 커밋했지만 GitHub 에 올리지 못한 커밋은 브랜치로 남기고, 그 파일도 백업에 넣는다
  const unpushed = head ? await keepUnpushed(root, head, target, ctx, String(d.id)).catch(() => null) : null;
  if (unpushed) log(`⚠ GitHub 에 올리지 않은 커밋이 있어 ${unpushed.ref} 브랜치에 보관했습니다. 코드는 GitHub 버전으로 바뀝니다.`);
  if (head !== target || modified.length) {
    const plan = await planCheckout(app, root, head, target, modified, ctx, d.id, unpushed?.files ?? []);
    if (plan.danger.length) {
      log(`로컬에서 바뀌었거나 저장소와 겹치는 파일 ${plan.danger.length}개를 백업: ${plan.backupDir}`);
    }
    onTreeChange();
    await git.checkoutForce(root, app.config.branch, target, { ...ctx, onLine: gitLog });
    for (const f of plan.keepLocal) {
      restoreFile(plan.backupDir, root, f, id);
    }
    if (plan.keepLocal.length) {
      log(`로컬 버전 유지 ${plan.keepLocal.length}개: ${plan.keepLocal.slice(0, 10).join(', ')}${plan.keepLocal.length > 10 ? ' ...' : ''}`);
    }
    const overwritten = plan.danger.filter((f) => !plan.keepLocal.includes(f));
    if (overwritten.length) {
      log(`저장소 버전으로 덮어씀 ${overwritten.length}개 (원본은 백업에 있음): ${overwritten.slice(0, 10).join(', ')}`);
    }
  } else {
    log('이미 최신 커밋입니다');
  }
  const wd = workDir(app);
  if (!fs.existsSync(wd)) throw new Error(`루트 폴더가 저장소에 없습니다: ${app.config.rootDir}`);

  // 3. 런타임
  log('');
  log('━━ 3/6 런타임 준비');
  let runtimeDesc = '';
  if (app.config.runtime === 'node') {
    const bin = await ensureNode(app.config.runtimeVersion, log);
    await ensureCorepack(bin);
    runtimeDesc = `node ${path.basename(path.dirname(bin))}`;
  } else {
    const py = await ensurePython(app.config.runtimeVersion, log);
    await ensureUv(log);
    await ensureVenv(app, py, id, log);
    runtimeDesc = `python ${py}`;
  }
  log(runtimeDesc);
  await writeRuntime(app);
  const env = buildEnv(app, { forBuild: true });

  // 4. 의존성
  log('');
  log('━━ 4/6 의존성 설치');
  const installCmd = app.config.installCmd || (app.config.runtime === 'node' ? nodeInstallCmd(wd).cmd : pythonInstallCmd(wd).cmd);
  const hash = depsHash(app, wd, installCmd);
  const marker = path.join(appDataDir(app.slug), 'deps.hash');
  const prevHash = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  const depsPresent = app.config.runtime === 'node' ? fs.existsSync(path.join(wd, 'node_modules')) || !fs.existsSync(path.join(wd, 'package.json')) : true;
  if (!installCmd) {
    log('설치할 의존성 파일이 없습니다 (건너뜀)');
  } else if (!app.config.installAlways && prevHash === hash && depsPresent) {
    log('의존성 파일이 바뀌지 않아 설치를 건너뜁니다');
  } else {
    await step(installCmd, wd, env, id, log);
    fs.writeFileSync(marker, hash);
  }

  // 5. 빌드 / 릴리스
  log('');
  log('━━ 5/6 빌드');
  if (app.config.buildCmd) await step(app.config.buildCmd, wd, env, id, log);
  else log('빌드 명령 없음');
  if (app.config.releaseCmd) {
    log('릴리스 명령 (마이그레이션 등):');
    await step(app.config.releaseCmd, wd, { ...env, CI: '' }, id, log);
  }

  // 6. 재시작 + 헬스체크
  log('');
  log('━━ 6/6 실행');
  const fresh = getApp(app.slug);
  if (!fresh.config.startCmd) {
    const det = detect(wd);
    throw new Error(`시작 명령이 비어 있습니다. 설정에서 입력하세요.${det.startCmd ? ` (추천: ${det.startCmd})` : ''}`);
  }
  if (fresh.desired_state === 'stopped') {
    log('앱이 "정지" 상태라 시작하지 않았습니다. 시작 버튼을 누르면 새 버전으로 실행됩니다.');
  } else {
    await writeRuntime(fresh);
    const unit = UNIT.app(app.slug);
    const before = await systemd.show([unit], ['NRestarts']);
    const baseRestarts = Number(before.get(unit)?.NRestarts ?? 0);
    await tryRun('systemctl', ['reset-failed', unit]);
    await systemd.systemctl('restart', unit);
    log(`systemctl restart ${unit}`);
    await healthCheck(fresh, baseRestarts, log);
  }
  return { sha: target, remoteSha };
}

/** 앱 사용자로 bash -c 실행, 출력은 배포 로그로 */
async function step(cmd: string, cwd: string, env: Record<string, string>, id: Identity, log: Log) {
  log(`$ ${cmd}`);
  const started = Date.now();
  await run('/bin/bash', ['-c', cmd], {
    cwd,
    env,
    cleanEnv: true,
    uid: id.uid,
    gid: id.gid,
    timeoutMs: 60 * 60_000,
    onLine: (l) => log(`  ${l}`),
  }).catch((e) => {
    throw new Error(`명령 실패 (${cmd}): 종료 코드 ${(e as { code?: number }).code ?? '?'}`);
  });
  log(`  (${((Date.now() - started) / 1000).toFixed(1)}초)`);
}

function depsHash(app: App, wd: string, installCmd: string) {
  const h = crypto.createHash('sha256');
  h.update(`${app.config.runtime}|${app.config.runtimeVersion}|${installCmd}`);
  for (const f of manifestFiles(app.config.runtime)) {
    const p = path.join(wd, f);
    if (fs.existsSync(p)) h.update(`\n${f}\n`).update(fs.readFileSync(p));
  }
  return h.digest('hex');
}

const corepackDone = new Set<string>();
async function ensureCorepack(bin: string) {
  if (corepackDone.has(bin)) return;
  const cp = path.join(bin, 'corepack');
  if (fs.existsSync(cp)) await tryRun(cp, ['enable'], { env: { PATH: `${bin}:/usr/bin:/bin` } });
  corepackDone.add(bin);
}

async function ensureVenv(app: App, python: string, id: Identity, log: Log) {
  const dir = venvDir(app.slug);
  const stampFile = path.join(dir, '.hrone-python');
  const ok = fs.existsSync(path.join(dir, 'bin', 'python')) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === python;
  if (ok) return;
  log(`가상환경 생성: ${dir}`);
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.chownSync(dir, id.uid, id.gid);
  const uv = await ensureUv(log);
  await run(uv, ['venv', '--allow-existing', '--seed', '--python', python, dir], {
    env: { ...pyEnv(), HOME: id.home, UV_CACHE_DIR: path.join(id.home, '.cache', 'uv') },
    cleanEnv: true,
    uid: id.uid,
    gid: id.gid,
    onLine: (l) => l.trim() && log(`  ${l}`),
  });
  fs.writeFileSync(stampFile, python);
  fs.chownSync(stampFile, id.uid, id.gid);
  // 새 가상환경이므로 의존성 다시 설치
  fs.rmSync(path.join(appDataDir(app.slug), 'deps.hash'), { force: true });
}

async function healthCheck(app: App, baseRestarts: number, log: Log) {
  const unit = UNIT.app(app.slug);
  const timeout = app.config.healthTimeoutSec * 1000;
  const stableMs = Math.min(5000, timeout);
  const url = app.config.healthPath && app.config.port ? `http://127.0.0.1:${app.config.port}${app.config.healthPath}` : null;
  log(url ? `헬스체크: ${url} (최대 ${app.config.healthTimeoutSec}초)` : `프로세스 안정성 확인 (${stableMs / 1000}초)`);
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeout + 1000) {
    await sleep(1000);
    const p = (await systemd.show([unit], ['ActiveState', 'SubState', 'NRestarts', 'ExecMainStatus'])).get(unit) ?? {};
    if (p.ActiveState === 'failed' || Number(p.NRestarts ?? 0) > baseRestarts || (p.ActiveState === 'inactive' && Date.now() - start > 1500)) {
      throw new Error(`앱 프로세스가 종료되었습니다 (exit ${p.ExecMainStatus ?? '?'}).\n${await tailLog(unit)}`);
    }
    if (url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
        if (res.status < 400) {
          log(`  응답 ${res.status} ✓`);
          return;
        }
        lastErr = `HTTP ${res.status}`;
      } catch (e) {
        lastErr = errMsg(e);
      }
    } else if (Date.now() - start >= stableMs && p.ActiveState === 'active') {
      log('  실행 중 ✓');
      return;
    }
  }
  throw new Error(`헬스체크 실패 (${lastErr || '시간 초과'}).\n${await tailLog(unit)}`);
}

async function tailLog(unit: string) {
  const entries = await journal.recent(unit, 25);
  return entries.map((e) => e.m).join('\n');
}

// ---------- 로컬 데이터 보존 ----------

/** rootDir 기준 패턴을 저장소 루트 기준으로 */
export function scopePatterns(patterns: string[], rootDir: string) {
  if (!rootDir) return patterns;
  return patterns.map((p) => {
    const t = p.trim();
    if (t.startsWith('/')) return `/${rootDir}${t}`;
    if (t.replace(/\/$/, '').includes('/')) return `/${rootDir}/${t}`;
    return t;
  });
}

export interface CheckoutPlan {
  danger: string[];
  keepLocal: string[];
  backupDir: string;
}

/**
 * checkout -f 가 덮어쓰거나 지우게 될 파일 중 "git 히스토리에 없는 내용" 만 골라 백업한다.
 *  - 로컬에서 수정된 추적 파일
 *  - 저장소에 새로 추가됐는데 로컬에 이미 있는 미추적 파일
 * 그 중 보존 경로에 해당하거나 (설정에 따라) 로컬 수정 파일은 반영 후 다시 되돌려 놓는다.
 * 저장소와 상관없는 미추적 파일(SQLite DB, 업로드 등)은 git 이 건드리지 않으므로 그대로 남는다.
 */
export async function planCheckout(
  app: App,
  root: string,
  head: string | null,
  target: string,
  modified: string[],
  ctx: Omit<git.GitCtx, 'cwd'>,
  deployId: number,
  /** 올리지 못한 커밋이 바꾼 파일 (체크아웃으로 사라지거나 바뀌므로 백업한다) */
  unpushedFiles: string[] = [],
): Promise<CheckoutPlan> {
  const onDisk = (f: string) => {
    try {
      fs.lstatSync(path.join(root, f));
      return true;
    } catch {
      return false;
    }
  };
  let upstream: string[];
  let collisions: Set<string>;
  if (head) {
    upstream = await git.diffNames(root, head, target, ctx);
    const headTree = await git.lsTree(root, head, ctx);
    collisions = new Set(upstream.filter((f) => !headTree.has(f) && onDisk(f)));
  } else {
    const targetTree = await git.lsTree(root, target, ctx);
    upstream = [...targetTree];
    collisions = new Set(upstream.filter(onDisk));
  }
  const mod = new Set(modified);
  const touched = new Set([...upstream, ...modified]);
  const local = new Set(unpushedFiles);
  const danger = [...new Set([...touched, ...local])].filter((f) => onDisk(f) && (collisions.has(f) || mod.has(f) || local.has(f)));
  const preserve = scopePatterns(app.config.preservePaths, app.config.rootDir);
  const keepLocal = danger.filter((f) => git.matchesAny(f, preserve) || (mod.has(f) && app.config.localChanges === 'keep'));
  const backupDir = path.join(PATHS.backups, 'apps', app.slug, 'deploys', `${deployId}-${Date.now()}`);
  if (danger.length) {
    for (const f of danger) {
      const src = path.join(root, f);
      const dst = path.join(backupDir, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    }
    fs.writeFileSync(path.join(backupDir, '.hrone-manifest.json'), JSON.stringify({ head, target, danger, keepLocal }, null, 2));
  }
  return { danger, keepLocal, backupDir };
}

function restoreFile(backupDir: string, root: string, f: string, id: Identity) {
  const src = path.join(backupDir, f);
  const dst = path.join(root, f);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  try {
    fs.lchownSync(dst, id.uid, id.gid);
  } catch {
    /* noop */
  }
}

function pruneDeployBackups(slug: string, keep = 20) {
  const dir = path.join(PATHS.backups, 'apps', slug, 'deploys');
  try {
    const entries = fs
      .readdirSync(dir)
      .map((name) => ({ name, t: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const e of entries.slice(keep)) rmrf(path.join(dir, e.name));
  } catch {
    /* 없음 */
  }
}

export function deployActor() {
  return SYSTEM;
}

export async function diffFor(d: Deploy, file: string | null) {
  const app = getAppById(d.app_id);
  if (!app || !d.to_sha) throw new HttpError(404, '비교할 커밋이 없습니다');
  const root = appDir(app.slug);
  const ctx = ctxFor(app);
  const from = d.from_sha ?? app.deployed_sha;
  if (!from) return { stat: [], patch: '' };
  if (!(await git.hasCommit(root, d.to_sha, ctx))) await git.fetch(root, app.config.repoUrl, app.config.branch, ctx);
  const stat = await git.diffStat(root, from, d.to_sha, ctx);
  const patch = file !== null ? await git.diffPatch(root, from, d.to_sha, file || null, ctx) : '';
  return { stat, patch, from, to: d.to_sha, web: git.repoWebUrl(app.config.repoUrl) };
}
