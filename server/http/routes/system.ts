import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../lib/audit.ts';
import { q } from '../../lib/db.ts';
import { PATHS } from '../../lib/paths.ts';
import { NO_LIMITS, settings } from '../../lib/settings.ts';
import type { Limits, PanelSettings } from '../../lib/types.ts';
import { clampInt, HttpError } from '../../lib/util.ts';
import { getApp, listApps, normalizeResources } from '../../services/apps.ts';
import * as autoupdate from '../../services/autoupdate.ts';
import * as backups from '../../services/backups.ts';
import { getDb, listDbs, dbLock } from '../../services/databases/index.ts';
import { getJob, listJobs, startJob } from '../../services/jobs.ts';
import * as journal from '../../services/journal.ts';
import { allStatuses, systemHistory, systemNow } from '../../services/monitor.ts';
import { isDiscordWebhook, notify } from '../../services/notify.ts';
import { ensureMariadb, ensureRedis } from '../../services/packages.ts';
import * as runtimes from '../../services/runtimes.ts';
import * as systemd from '../../services/systemd.ts';
import * as system from '../../services/system.ts';
import { actor, inCidr, reauth } from '../auth.ts';
import { appSummary } from './apps.ts';
import { dbSummary } from './databases.ts';
import * as deploy from '../../services/deploy.ts';
import { attachmentHeader } from '../../services/files.ts';

type Body = Record<string, any>;

export function registerSystem(server: FastifyInstance) {
  server.get('/api/dashboard', async () => ({
    apps: listApps().map(appSummary),
    databases: listDbs().map(dbSummary),
    open: deploy.openDeploys().map((d) => ({ ...d, appSlug: q.get<{ slug: string }>('SELECT slug FROM apps WHERE id = ?', d.app_id)?.slug })),
    recent: deploy.recentDeploys(10).map((d) => {
      const a = q.get<{ slug: string; name: string }>('SELECT slug, name FROM apps WHERE id = ?', d.app_id);
      return { ...d, appSlug: a?.slug, appName: a?.name };
    }),
    system: systemNow(),
    units: allStatuses(),
  }));

  server.get('/api/system/info', async () => system.info());

  server.get('/api/system/metrics', async (req) => {
    const range = (req.query as Body).range === '24h' ? '24h' : '1h';
    return { now: systemNow(), history: systemHistory(range), units: allStatuses() };
  });

  // ----- 전체 리소스 상한 -----

  server.get('/api/system/limits', async () => settings.limits());

  server.put('/api/system/limits', async (req) => {
    const b = (req.body ?? {}) as Partial<Limits>;
    const next: Limits = {
      total: normalizeResources({ ...NO_LIMITS, ...b.total }),
      apps: normalizeResources({ ...NO_LIMITS, ...b.apps }),
      dbs: normalizeResources({ ...NO_LIMITS, ...b.dbs }),
    };
    settings.setLimits(next);
    await systemd.writeSlices(next);
    audit(actor(req), 'system.limits', '', next);
    return next;
  });

  server.get('/api/system/tuning', async () => system.tuningStatus());
  server.post('/api/system/tuning', async (req) => {
    const keys = Array.isArray((req.body as Body)?.keys) ? ((req.body as Body).keys as string[]) : system.TUNING.map((t) => t.key);
    const r = await system.applyTuning(keys);
    audit(actor(req), 'system.tuning', '', r);
    return r;
  });

  server.get('/api/system/swap', async () => system.swapStatus());
  server.post('/api/system/swap', async (req) => {
    const size = clampInt((req.body as Body)?.sizeMB, 256, 64 * 1024, 2048);
    await system.createSwap(size);
    audit(actor(req), 'system.swap_create', '', { size });
    return system.swapStatus();
  });
  server.delete('/api/system/swap', async (req) => {
    await system.removeSwap();
    audit(actor(req), 'system.swap_remove');
    return system.swapStatus();
  });

  server.get('/api/system/timezones', async () => system.timezones());
  server.put('/api/system/timezone', async (req) => {
    const tz = String((req.body as Body)?.timezone ?? '');
    await system.setTimezone(tz);
    audit(actor(req), 'system.timezone', tz);
    return { ok: true, restartRecommended: true };
  });

  server.get('/api/system/journal', async () => ({ usage: await journal.diskUsage() }));
  server.post('/api/system/journal/vacuum', async (req) => {
    const size = String((req.body as Body)?.size ?? '1G');
    if (!/^\d+[KMG]$/.test(size)) throw new HttpError(400, '크기 형식: 500M, 2G');
    await journal.vacuum(size);
    return { usage: await journal.diskUsage() };
  });

  // ----- 구성 요소 -----

  server.get('/api/system/components', async () => system.components());

  server.get('/api/system/node-versions', async () => {
    const list = await runtimes.nodeIndex();
    const majors = new Map<string, { version: string; lts: string | false }>();
    for (const e of list) {
      const major = e.version.split('.')[0]!;
      if (!majors.has(major) && Number(major.slice(1)) >= 18) majors.set(major, { version: e.version, lts: e.lts });
    }
    return [...majors.values()].slice(0, 8);
  });

  server.post('/api/system/components/install', async (req) => {
    const b = (req.body ?? {}) as Body;
    const c = String(b.component);
    const version = String(b.version ?? '');
    const titles: Record<string, string> = { node: `Node.js ${version}`, python: `Python ${version}`, uv: 'uv', mariadb: 'MariaDB', redis: 'Redis' };
    if (!titles[c]) throw new HttpError(400, '알 수 없는 구성 요소');
    const job = startJob('install', c, `${titles[c]} 설치`, async (log) => {
      if (c === 'node') await runtimes.ensureNode(version || 'lts', log);
      else if (c === 'python') await runtimes.ensurePython(version || 'system', log);
      else if (c === 'uv') await runtimes.ensureUv(log);
      else if (c === 'mariadb') await ensureMariadb(log);
      else if (c === 'redis') await ensureRedis(log);
      log('완료');
    });
    audit(actor(req), 'system.install', c, { version });
    return { jobId: job.id };
  });

  server.post('/api/system/components/remove', async (req) => {
    const b = (req.body ?? {}) as Body;
    if (b.component === 'node') {
      const v = String(b.version);
      const users = listApps().filter((a) => a.config.runtime === 'node' && runtimes.matchInstalledNode(a.config.runtimeVersion) === v);
      if (users.length) throw new HttpError(409, `사용 중인 앱이 있습니다: ${users.map((a) => a.name).join(', ')}`);
      runtimes.removeNode(v);
    } else if (b.component === 'python') {
      await runtimes.removePython(String(b.version));
    } else throw new HttpError(400, '삭제할 수 없는 구성 요소');
    audit(actor(req), 'system.remove', String(b.component), { version: b.version });
    return { ok: true };
  });

  // ----- 패널 업데이트 -----

  server.get('/api/system/update/check', async () => system.updateCheck());
  server.post('/api/system/update', async (req) => {
    await autoupdate.startUpdate(actor(req).username);
    audit(actor(req), 'system.update');
    return { ok: true };
  });
  server.get('/api/system/update/status', async () => ({
    version: system.panelVersion(),
    current: await autoupdate.currentCommit(),
    settings: autoupdate.autoUpdateSettings(),
    state: autoupdate.autoUpdateState(),
    busy: autoupdate.busyReason(),
  }));
  server.put('/api/system/update/settings', async (req) => {
    const b = (req.body ?? {}) as Body;
    const r = autoupdate.setAutoUpdateSettings({
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      intervalHours: b.intervalHours === undefined ? undefined : Number(b.intervalHours),
    });
    audit(actor(req), 'settings.update', '', ['autoUpdate']);
    return r;
  });
  server.get('/api/system/update/log', async () => ({ log: await system.updateLog() }));
  server.post('/api/system/restart-panel', async (req) => {
    audit(actor(req), 'system.restart_panel');
    await system.restartPanel();
    return { ok: true };
  });

  // ----- 설정 -----

  server.get('/api/settings', async () => {
    const discord = settings.discordWebhook();
    return {
      panel: settings.panel(),
      defaults: settings.defaults(),
      alerts: settings.alerts(),
      githubTokenSet: !!settings.githubToken(),
      discordWebhook: discord ? discord.replace(/\/[\w-]{20,}$/, '/••••••') : '',
      discordSet: !!discord,
    };
  });

  server.put('/api/settings', async (req) => {
    const b = (req.body ?? {}) as Body;
    let restartNeeded = false;
    if (b.panel) {
      const cur = settings.panel();
      const p = b.panel as Partial<PanelSettings>;
      const next: PanelSettings = {
        port: clampInt(p.port ?? cur.port, 1, 65535, cur.port),
        access: p.access === 'all' || p.access === 'custom' ? p.access : 'private',
        allowedCidrs: (Array.isArray(p.allowedCidrs) ? p.allowedCidrs : cur.allowedCidrs).map((c) => String(c).trim()).filter(Boolean),
        baseUrl: String(p.baseUrl ?? cur.baseUrl).trim().replace(/\/+$/, ''),
      };
      for (const c of next.allowedCidrs) if (!inCidr(c.split('/')[0]!, c)) throw new HttpError(400, `CIDR 형식 오류: ${c}`);
      if (next.access === 'custom' && !next.allowedCidrs.some((c) => inCidr(req.clientIp, c))) {
        throw new HttpError(400, `지금 접속한 IP(${req.clientIp})가 허용 목록에 없어 저장하면 접속이 끊깁니다`);
      }
      if (next.port !== cur.port) restartNeeded = true;
      settings.setPanel(next);
    }
    if (b.defaults) {
      const d = settings.defaults();
      settings.setDefaults({ pollIntervalSec: clampInt(b.defaults.pollIntervalSec ?? d.pollIntervalSec, 15, 86400, 60), notify: { ...d.notify, ...b.defaults.notify } });
    }
    if (b.alerts) {
      const a = settings.alerts();
      settings.setAlerts({
        enabled: b.alerts.enabled ?? a.enabled,
        diskPercent: clampInt(b.alerts.diskPercent ?? a.diskPercent, 50, 100, 90),
        memPercent: clampInt(b.alerts.memPercent ?? a.memPercent, 50, 100, 95),
      });
    }
    if (typeof b.githubToken === 'string') settings.setGithubToken(b.githubToken.trim());
    if (typeof b.discordWebhook === 'string') {
      const url = b.discordWebhook.trim();
      if (url && !isDiscordWebhook(url)) throw new HttpError(400, '디스코드 웹후크 URL 형식이 아닙니다 (https://discord.com/api/webhooks/...)');
      settings.setDiscordWebhook(url);
    }
    audit(actor(req), 'settings.update', '', Object.keys(b));
    return { ok: true, restartNeeded };
  });

  server.post('/api/settings/test-discord', async () => {
    const url = settings.discordWebhook();
    if (!url) throw new HttpError(400, '전역 디스코드 웹후크를 먼저 저장하세요');
    await notify({ kind: 'test', title: '🔔 HROne 테스트 알림', description: '전역 디스코드 알림이 잘 도착했습니다.', color: 'purple' });
    return { ok: true };
  });

  server.get('/api/audit', async (req) => {
    const qs = req.query as Body;
    const limit = clampInt(qs.limit, 1, 500, 100);
    const before = Number(qs.before) || Number.MAX_SAFE_INTEGER;
    return q.all('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?', before, limit);
  });

  // ----- 작업 -----

  server.get('/api/jobs', async () => listJobs());
  server.get('/api/jobs/:id', async (req) => {
    const job = getJob(Number((req.params as { id: string }).id));
    if (!job) throw new HttpError(404, '작업이 없습니다 (완료 후 1시간이 지났을 수 있습니다)');
    return job;
  });

  // ----- 백업 -----

  server.get('/api/backups', async (req) => {
    const qs = req.query as Body;
    return backups.listBackups(qs.kind, qs.slug);
  });

  server.post('/api/backups', async (req) => {
    const b = (req.body ?? {}) as Body;
    const slug = String(b.slug ?? '');
    if (b.kind === 'database') {
      const db = getDb(slug);
      const job = startJob('backup', slug, `${db.name} 백업`, async (log) => {
        const file = await dbLock.run(slug, () => backups.backupDatabase(getDb(slug), 'manual', String(b.note ?? '')));
        log(`완료: ${path.basename(file)}`);
        return backups.downloadPathFor(file);
      });
      audit(actor(req), 'backup.create', slug);
      return { jobId: job.id };
    }
    if (b.kind === 'app') {
      const app = getApp(slug);
      const job = startJob('backup', slug, `${app.name} 데이터 백업`, async (log) => {
        const file = await backups.backupAppData(getApp(slug), 'manual', !!b.full);
        log(`완료: ${path.basename(file)}`);
        return backups.downloadPathFor(file);
      });
      audit(actor(req), 'backup.create', slug);
      return { jobId: job.id };
    }
    throw new HttpError(400, 'kind 는 database 또는 app');
  });

  server.post('/api/backups/:id/restore', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as Body;
    reauth(req, b.password, b.totp);
    const bk = backups.getBackup(id);
    const job = bk.kind === 'database' ? backups.restoreDatabase(bk.target_slug, id, actor(req)) : backups.restoreAppData(bk.target_slug, id, actor(req));
    return { jobId: job.id };
  });

  server.delete('/api/backups/:id', async (req) => {
    backups.deleteBackup(Number((req.params as { id: string }).id), actor(req));
    return { ok: true };
  });

  server.get('/api/backups/:id/download', async (req, reply) => {
    const bk = backups.getBackup(Number((req.params as { id: string }).id));
    if (!bk.file.startsWith(PATHS.backups + path.sep) || !fs.existsSync(bk.file)) throw new HttpError(404, '파일이 없습니다');
    audit(actor(req), 'backup.download', bk.target_slug, { id: bk.id });
    reply.header('content-disposition', attachmentHeader(path.basename(bk.file)));
    reply.header('content-length', fs.statSync(bk.file).size);
    reply.header('content-type', 'application/gzip');
    return reply.send(fs.createReadStream(bk.file));
  });

  server.post('/api/system/verify', async (req) => {
    const b = (req.body ?? {}) as Body;
    reauth(req, b.password, b.totp);
    return { ok: true };
  });
}
