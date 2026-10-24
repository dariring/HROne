import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../../lib/audit.ts';
import { errMsg } from '../../lib/log.ts';
import { randomToken } from '../../lib/crypto.ts';
import { getSetting, q, setSetting } from '../../lib/db.ts';
import { run } from '../../lib/exec.ts';
import { appDataDir, appDir, PATHS, UNIT } from '../../lib/paths.ts';
import { settings } from '../../lib/settings.ts';
import type { App, AppConfig, EnvVar } from '../../lib/types.ts';
import { HttpError, rmrf } from '../../lib/util.ts';
import * as appgit from '../../services/appgit.ts';
import { checkApp } from '../../services/watcher.ts';
import * as apps from '../../services/apps.ts';
import { backupAppData } from '../../services/backups.ts';
import { connectionEnv, linksForApp } from '../../services/databases/links.ts';
import { getDb, getDbById, terminateDatabase } from '../../services/databases/index.ts';
import { backupDatabase } from '../../services/backups.ts';
import * as deploy from '../../services/deploy.ts';
import { scopePatterns } from '../../services/deploy.ts';
import { detect } from '../../services/detect.ts';
import * as git from '../../services/git.ts';
import * as journal from '../../services/journal.ts';
import { getStatus, unitHistoryOf } from '../../services/monitor.ts';
import { notify } from '../../services/notify.ts';
import type { Identity } from '../../services/users.ts';
import { actor, reauth } from '../auth.ts';
import { registerFileRoutes } from './files.ts';

type Body = Record<string, any>;

export function appSummary(app: App) {
  const open = q.get<{ id: number; status: string; to_sha: string; scheduled_at: number | null }>(
    `SELECT id, status, to_sha, scheduled_at FROM deploys WHERE app_id = ? AND status IN ('pending','scheduled','queued','running') ORDER BY id DESC LIMIT 1`,
    app.id,
  );
  const last = q.get<{ id: number; status: string; finished_at: number | null }>(
    `SELECT id, status, finished_at FROM deploys WHERE app_id = ? AND status NOT IN ('pending','scheduled','queued','running','superseded') ORDER BY id DESC LIMIT 1`,
    app.id,
  );
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    runtime: app.config.runtime,
    runtimeVersion: app.config.runtimeVersion,
    repoUrl: app.config.repoUrl,
    repoWeb: git.repoWebUrl(app.config.repoUrl),
    branch: app.config.branch,
    port: app.config.port,
    publicUrl: app.config.publicUrl,
    deployMode: app.config.deployMode,
    deployDelaySec: app.config.deployDelaySec,
    autostart: app.config.autostart,
    desiredState: app.desired_state,
    deployedSha: app.deployed_sha,
    deployedAt: app.deployed_at,
    lastPollAt: app.last_poll_at,
    lastPollError: app.last_poll_error,
    status: getStatus(UNIT.app(app.slug)),
    openDeploy: open ?? null,
    lastDeploy: last ?? null,
    busy: deploy.isAppBusy(app.id),
  };
}

const rootIdentity = (): Identity => {
  const home = path.join(PATHS.tmp, 'inspect-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return { user: 'root', uid: 0, gid: 0, home };
};

const tmpKeyPath = (id: string) => {
  if (!/^[\w-]{16,64}$/.test(id)) throw new HttpError(400, '잘못된 키 ID');
  return path.join(PATHS.tmp, 'keys', id);
};

function inspectAuth(b: Body): git.GitAuth {
  if (b.auth === 'token') return { type: 'token', token: String(b.gitToken || '') || settings.githubToken() };
  if (b.auth === 'deploykey') return { type: 'deploykey', keyPath: tmpKeyPath(String(b.keyId ?? '')) };
  return { type: 'none' };
}

export async function sendLogs(reply: FastifyReply, unit: string, name: string) {
  const since = getSetting<number>(`logclear:${unit}`, 0) || undefined;
  reply.header('content-type', 'text/plain; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.log"`);
  const child = journal.exportTo(unit, reply.raw, since);
  reply.hijack();
  child.on('close', () => reply.raw.end());
}

export async function recentLogs(unit: string, lines: number) {
  const since = getSetting<number>(`logclear:${unit}`, 0) || undefined;
  return journal.recent(unit, Math.min(Math.max(lines, 10), 5000), since);
}

export function clearLogs(unit: string) {
  setSetting(`logclear:${unit}`, Date.now());
}

export function registerApps(server: FastifyInstance) {
  server.get('/api/apps', async () => apps.listApps().map(appSummary));

  // ----- 생성 마법사 -----

  server.post('/api/repo/deploykey', async () => {
    const id = randomToken(18);
    const kp = tmpKeyPath(id);
    fs.mkdirSync(path.dirname(kp), { recursive: true, mode: 0o700 });
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hrone-deploy', '-f', kp, '-q']);
    return { keyId: id, publicKey: fs.readFileSync(kp + '.pub', 'utf8').trim() };
  });

  server.post('/api/repo/inspect', async (req) => {
    const b = (req.body ?? {}) as Body;
    const authType = (['none', 'token', 'deploykey'].includes(b.auth) ? b.auth : 'none') as git.GitAuth['type'];
    const url = git.normalizeRepoUrl(String(b.repoUrl ?? ''), authType);
    const auth = inspectAuth({ ...b, auth: authType });
    const id = rootIdentity();
    const { branches, defaultBranch } = await git.listBranches(url, { id, auth });
    const branch = String(b.branch || defaultBranch);
    if (!branches.some((x) => x.name === branch)) {
      return { url, branches, defaultBranch, detection: null, error: `브랜치 ${branch} 가 없습니다` };
    }
    const dir = fs.mkdtempSync(path.join(PATHS.tmp, 'inspect-'));
    try {
      try {
        await git.clone(url, branch, path.join(dir, 'repo'), { id, auth }, 1);
      } catch (e) {
        // 단순(dumb) HTTP 저장소 등 shallow clone 을 못 하는 서버
        if (!/shallow/i.test((e as Error).message)) throw e;
        rmrf(path.join(dir, 'repo'));
        await git.clone(url, branch, path.join(dir, 'repo'), { id, auth });
      }
      const root = path.join(dir, 'repo', String(b.rootDir ?? '').replace(/^\/+|\/+$/g, ''));
      return { url, branches, defaultBranch, detection: detect(root) };
    } finally {
      rmrf(dir);
    }
  });

  server.get('/api/github/repos', async () => {
    const token = settings.githubToken();
    if (!token) return { tokenSet: false, repos: [] };
    const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=pushed', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'HROne' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(502, `GitHub API 오류 ${res.status} — 토큰 권한을 확인하세요`);
    const list = (await res.json()) as { full_name: string; private: boolean; default_branch: string; pushed_at: string; description: string | null }[];
    return {
      tokenSet: true,
      repos: list.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at, description: r.description })),
    };
  });

  server.post('/api/apps', async (req) => {
    const b = (req.body ?? {}) as Body;
    const config = (b.config ?? {}) as Partial<AppConfig>;
    const created = await apps.createApp(
      { slug: b.slug, name: b.name, config, env: Array.isArray(b.env) ? b.env : b.envText ? apps.parseDotenv(String(b.envText)) : [], gitToken: b.gitToken, discordWebhook: b.discordWebhook },
      actor(req),
    );
    if (config.auth === 'deploykey' && b.keyId) {
      // 마법사에서 만든 임시 키를 앱 전용 키로 옮긴다
      const src = tmpKeyPath(String(b.keyId));
      if (fs.existsSync(src)) {
        const id = apps.appIdentity(created);
        const dst = apps.keyPath(created.slug);
        fs.copyFileSync(src, dst);
        fs.copyFileSync(src + '.pub', dst + '.pub');
        fs.chmodSync(dst, 0o600);
        fs.chownSync(dst, id.uid, id.gid);
        fs.chownSync(dst + '.pub', id.uid, id.gid);
        fs.rmSync(src, { force: true });
        fs.rmSync(src + '.pub', { force: true });
      }
    }
    if (Array.isArray(b.links)) {
      for (const l of b.links as { database: string; prefix?: string }[]) {
        const db = getDb(String(l.database));
        q.run('INSERT OR REPLACE INTO app_links (app_id, database_id, prefix) VALUES (?, ?, ?)', created.id, db.id, normPrefix(l.prefix));
      }
    }
    const deployId = b.deployNow === false ? null : await deploy.requestDeploy(created.slug, { trigger: 'initial', actor: actor(req) });
    return { app: appSummary(apps.getApp(created.slug)), deployId };
  });

  // ----- 상세 / 수정 -----

  server.get('/api/apps/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const app = apps.getApp(slug);
    const links = linksForApp(app.id).map((l) => {
      const db = getDbById(l.database_id);
      return { slug: db?.slug, name: db?.name, type: db?.type, prefix: l.prefix, port: db?.config.port, keys: connectionEnv(l.database_id, l.prefix).map((v) => v.key) };
    });
    return {
      ...appSummary(app),
      config: app.config,
      createdAt: app.created_at,
      deployKey: app.config.auth === 'deploykey' ? apps.deployKeyPub(slug) : null,
      webhookPath: `/api/hooks/github/${slug}`,
      links,
      envCount: apps.getEnv(slug).length,
      history: unitHistoryOf(UNIT.app(slug)),
      dir: path.join(PATHS.apps, slug),
      dataDir: appDataDir(slug),
      rejectedSha: app.rejected_sha,
      lastSeenSha: app.last_seen_sha,
    };
  });

  server.patch('/api/apps/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const r = await apps.updateApp(slug, { name: b.name, config: b.config }, actor(req));
    return { app: appSummary(r.app), redeploy: r.redeploy };
  });

  server.get('/api/apps/:slug/detect', async (req) => {
    const { slug } = req.params as { slug: string };
    const app = apps.getApp(slug);
    return detect(apps.workDir(app));
  });

  server.post('/api/apps/:slug/action', async (req) => {
    const { slug } = req.params as { slug: string };
    const { action } = (req.body ?? {}) as Body;
    if (!['start', 'stop', 'restart', 'kill'].includes(action)) throw new HttpError(400, '알 수 없는 동작');
    await apps.lifecycle(slug, action, actor(req));
    return { ok: true };
  });

  server.post('/api/apps/:slug/autostart', async (req) => {
    const { slug } = req.params as { slug: string };
    await apps.setAutostart(slug, !!(req.body as Body)?.enabled, actor(req));
    return { ok: true };
  });

  // ----- 환경변수 -----

  server.get('/api/apps/:slug/env', async (req) => {
    const { slug } = req.params as { slug: string };
    const app = apps.getApp(slug);
    const linked = linksForApp(app.id).flatMap((l) => connectionEnv(l.database_id, l.prefix));
    const system = Object.entries(apps.buildEnv({ ...app, id: -1 })).filter(([k]) => !apps.getEnv(slug).some((v) => v.key === k));
    return {
      vars: apps.getEnv(slug),
      linked,
      system: system.filter(([k]) => !linked.some((l) => l.key === k)).map(([key, value]) => ({ key, value })),
      text: apps.toDotenv(apps.getEnv(slug)),
    };
  });

  server.put('/api/apps/:slug/env', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const vars: EnvVar[] = typeof b.text === 'string' ? apps.parseDotenv(b.text) : Array.isArray(b.vars) ? b.vars : [];
    apps.setEnv(slug, vars);
    const app = apps.getApp(slug);
    if (app.deployed_sha) await apps.writeRuntime(app);
    audit(actor(req), 'app.env', slug, { keys: vars.map((v) => v.key) });
    const running = getStatus(UNIT.app(slug))?.state === 'running';
    if (b.restart && running) await apps.lifecycle(slug, 'restart', actor(req));
    return { ok: true, count: vars.length, restartNeeded: running && !b.restart };
  });

  // ----- 비밀값 / 키 / 웹후크 -----

  server.get('/api/apps/:slug/secrets', async (req) => {
    const { slug } = req.params as { slug: string };
    const s = apps.getSecrets(slug);
    return { webhookSecret: s.webhookSecret, discordWebhook: s.discordWebhook, gitTokenSet: !!s.gitToken };
  });

  server.put('/api/apps/:slug/secrets', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const s = apps.getSecrets(slug);
    if (typeof b.discordWebhook === 'string') s.discordWebhook = b.discordWebhook.trim();
    if (typeof b.gitToken === 'string') s.gitToken = b.gitToken.trim();
    if (b.regenerateWebhook) s.webhookSecret = randomToken(24);
    apps.setSecrets(slug, s);
    audit(actor(req), 'app.secrets', slug, { discord: typeof b.discordWebhook === 'string', token: typeof b.gitToken === 'string', webhook: !!b.regenerateWebhook });
    return { webhookSecret: s.webhookSecret, discordWebhook: s.discordWebhook, gitTokenSet: !!s.gitToken };
  });

  server.post('/api/apps/:slug/deploykey', async (req) => {
    const { slug } = req.params as { slug: string };
    const key = await apps.generateDeployKey(apps.getApp(slug));
    audit(actor(req), 'app.deploykey', slug);
    return { publicKey: key };
  });

  server.post('/api/apps/:slug/test-notify', async (req) => {
    const { slug } = req.params as { slug: string };
    const app = apps.getApp(slug);
    const url = apps.getSecrets(slug).discordWebhook || settings.discordWebhook();
    if (!url) throw new HttpError(400, '디스코드 웹후크가 설정되지 않았습니다 (앱 또는 전역 설정)');
    await notify({ kind: 'test', app, title: `🔔 ${app.name}: 테스트 알림`, description: 'HROne 알림이 잘 도착했습니다.', color: 'purple', webhookOverride: url });
    return { ok: true };
  });

  // ----- 로그 -----

  server.get('/api/apps/:slug/logs', async (req) => {
    const { slug } = req.params as { slug: string };
    apps.getAppRow(slug);
    const lines = Number((req.query as Body).lines ?? 500);
    return recentLogs(UNIT.app(slug), lines);
  });

  server.get('/api/apps/:slug/logs/download', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    apps.getAppRow(slug);
    await sendLogs(reply, UNIT.app(slug), slug);
  });

  server.post('/api/apps/:slug/logs/clear', async (req) => {
    const { slug } = req.params as { slug: string };
    apps.getAppRow(slug);
    clearLogs(UNIT.app(slug));
    return { ok: true };
  });

  // ----- 파일 · git -----

  const appOf = (req: FastifyRequest) => apps.getApp((req.params as { slug: string }).slug);
  // 배포가 작업 폴더를 바꾸는 중에는 고치거나 커밋하지 않는다
  const notDeploying = (app: App) => {
    if (deploy.isAppBusy(app.id)) throw new HttpError(409, '배포가 진행 중입니다. 끝난 뒤에 다시 하세요.');
  };
  const repoOf = (app: App) => ({ dir: appDir(app.slug), branch: app.config.branch, url: app.config.repoUrl, ctx: { id: apps.appIdentity(app), auth: apps.gitAuthFor(app) } });

  registerFileRoutes(server, '/api/apps/:slug/files', {
    root: (req) => appDir(appOf(req).slug),
    onDownload: (req, rel) => audit(actor(req), 'app.file_download', (req.params as { slug: string }).slug, { path: rel }),
    write: {
      owner: (req) => apps.appIdentity(appOf(req)),
      guard: (req) => notDeploying(appOf(req)),
      onWrite: (req, rel, kind) => audit(actor(req), kind === 'edit' ? 'app.file_edit' : 'app.file_create', (req.params as { slug: string }).slug, { path: rel }),
    },
  });

  server.get('/api/apps/:slug/git/status', async (req) => {
    const app = appOf(req);
    if (!fs.existsSync(path.join(appDir(app.slug), '.git'))) throw new HttpError(404, '아직 받아 온 저장소가 없습니다');
    const st = await appgit.status(repoOf(app));
    const preserve = scopePatterns(app.config.preservePaths, app.config.rootDir);
    // 서버에 남길 파일(SQLite 등)은 커밋 창에서 기본으로 빼 둔다
    const files = st.files.map((f) => ({ ...f, preserved: git.matchesAny(f.path, preserve) }));
    return { ...st, files, auth: app.config.auth, localChanges: app.config.localChanges };
  });

  // 올린 커밋은 평소 푸시처럼 이 앱의 배포 방식(바로/잠시 뒤/승인 후)을 따른다
  const afterPush = (app: App) => void checkApp(app).catch(() => {});

  server.post('/api/apps/:slug/git/commit', async (req) => {
    const app = appOf(req);
    const b = (req.body ?? {}) as Body;
    notDeploying(app);
    const files = Array.isArray(b.files) ? b.files.map(String) : [];
    const sha = await appgit.commit(repoOf(app), files, String(b.message ?? ''), actor(req).username);
    audit(actor(req), 'app.git_commit', app.slug, { sha, files: files.slice(0, 20), message: String(b.message ?? '').slice(0, 200) });
    if (!b.push) return { sha, pushed: false };
    try {
      await appgit.push(repoOf(app));
    } catch (e) {
      // 커밋은 이미 만들어졌으니 그 사실을 같이 알린다 (나중에 "올리기" 로 다시 시도)
      throw new HttpError(e instanceof HttpError ? e.status : 500, `커밋 ${sha} 은 만들었지만 GitHub 에 올리지 못했습니다. ${errMsg(e)}`);
    }
    audit(actor(req), 'app.git_push', app.slug, { sha });
    afterPush(app);
    return { sha, pushed: true, deployMode: app.config.deployMode };
  });

  server.post('/api/apps/:slug/git/push', async (req) => {
    const app = appOf(req);
    notDeploying(app);
    const sha = await appgit.push(repoOf(app));
    audit(actor(req), 'app.git_push', app.slug, { sha: sha.slice(0, 7) });
    afterPush(app);
    return { pushed: true, deployMode: app.config.deployMode };
  });

  // ----- DB 연결 -----

  server.post('/api/apps/:slug/links', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const app = apps.getApp(slug);
    const db = getDb(String(b.database));
    const prefix = normPrefix(b.prefix);
    const clash = linksForApp(app.id).find((l) => l.database_id !== db.id && l.prefix === prefix && getDbById(l.database_id)?.type === db.type);
    if (clash) throw new HttpError(409, '같은 종류의 DB 가 같은 접두사로 이미 연결돼 있습니다. 접두사를 지정하세요 (예: CACHE_)');
    q.run('INSERT OR REPLACE INTO app_links (app_id, database_id, prefix) VALUES (?, ?, ?)', app.id, db.id, prefix);
    if (app.deployed_sha) await apps.writeRuntime(apps.getApp(slug));
    audit(actor(req), 'app.link', slug, { db: db.slug, prefix });
    return { ok: true, restartNeeded: getStatus(UNIT.app(slug))?.state === 'running' };
  });

  server.delete('/api/apps/:slug/links/:db', async (req) => {
    const { slug, db: dbSlug } = req.params as { slug: string; db: string };
    const app = apps.getApp(slug);
    const db = getDb(dbSlug);
    q.run('DELETE FROM app_links WHERE app_id = ? AND database_id = ?', app.id, db.id);
    if (app.deployed_sha) await apps.writeRuntime(apps.getApp(slug));
    audit(actor(req), 'app.unlink', slug, { db: db.slug });
    return { ok: true, restartNeeded: getStatus(UNIT.app(slug))?.state === 'running' };
  });

  // ----- 삭제 (2단계 확인) -----

  server.post('/api/apps/:slug/terminate', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const app = apps.getApp(slug);
    if (b.confirm !== slug) throw new HttpError(400, '확인용 앱 ID 가 일치하지 않습니다');
    reauth(req, b.password, b.totp);
    const dbSlugs: string[] = Array.isArray(b.databases) ? b.databases.map(String) : [];
    const linkedIds = new Set(linksForApp(app.id).map((l) => l.database_id));
    for (const s of dbSlugs) {
      if (!linkedIds.has(getDb(s).id)) throw new HttpError(400, `${s} 는 이 앱에 연결된 DB 가 아닙니다`);
    }
    const res = await apps.terminateApp(slug, { backup: b.backup !== false }, actor(req), (a) => backupAppData(a, 'terminate', true));
    const dbResults: { slug: string; backupFile: string | null }[] = [];
    for (const s of dbSlugs) {
      const r = await terminateDatabase(s, actor(req), b.backup !== false ? (db) => backupDatabase(db, 'terminate') : null);
      dbResults.push({ slug: s, backupFile: r.backupFile });
    }
    return { ok: true, backupFile: res.backupFile, databases: dbResults };
  });

  server.get('/api/apps/:slug/metrics', async (req) => {
    const { slug } = req.params as { slug: string };
    return { status: getStatus(UNIT.app(slug)), history: unitHistoryOf(UNIT.app(slug)) };
  });
}

export function normPrefix(v: unknown) {
  const p = String(v ?? '').trim().toUpperCase();
  if (p && !/^[A-Z][A-Z0-9_]{0,30}$/.test(p)) throw new HttpError(400, '접두사는 영문 대문자/숫자/_ (예: MAIN_)');
  return p;
}
