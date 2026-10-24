import fs from 'node:fs';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { clientIp, ipAllowed, loadSession } from './http/auth.ts';
import { registerWeb } from './http/web.ts';
import { registerApps } from './http/routes/apps.ts';
import { registerAuth } from './http/routes/auth.ts';
import { registerDatabases } from './http/routes/databases.ts';
import { registerDeploys } from './http/routes/deploys.ts';
import { registerSystem } from './http/routes/system.ts';
import { registerWs } from './http/ws.ts';
import { openDb } from './lib/db.ts';
import { errMsg, log } from './lib/log.ts';
import { DATA, PATHS, UNIT } from './lib/paths.ts';
import { tryRun } from './lib/exec.ts';
import { settings } from './lib/settings.ts';
import { HttpError } from './lib/util.ts';
import { ensureAppIdentity, listApps, setDesired, writeRuntime } from './services/apps.ts';
import { scheduledTick } from './services/backups.ts';
import { listDbs, writeRuntime as writeDbRuntime } from './services/databases/index.ts';
import { recoverOnBoot, schedulerTick } from './services/deploy.ts';
import { startMonitor } from './services/monitor.ts';
import { notify } from './services/notify.ts';
import { writeSlices } from './services/systemd.ts';
import { pollTick } from './services/watcher.ts';

for (const d of [DATA, PATHS.apps, PATHS.appdata, PATHS.databases, PATHS.backups, PATHS.deployLogs, PATHS.runtimes, PATHS.tmp]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.chmodSync(DATA, 0o711);
fs.chmodSync(PATHS.backups, 0o700);
openDb();

const server = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy: false });

// 웹후크 서명 확인용으로 원본 바디를 보관
server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
  if (!(body as Buffer).length) return done(null, {});
  try {
    done(null, JSON.parse((body as Buffer).toString('utf8')));
  } catch {
    done(new HttpError(400, 'JSON 형식 오류'), undefined);
  }
});
server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (req, body, done) => {
  (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
  const params = new URLSearchParams((body as Buffer).toString('utf8'));
  const payload = params.get('payload');
  try {
    done(null, payload ? JSON.parse(payload) : Object.fromEntries(params));
  } catch {
    done(new HttpError(400, '본문 형식 오류'), undefined);
  }
});

await server.register(cookie);
await server.register(websocket, { options: { maxPayload: 1024 * 1024 } });

server.decorateRequest('clientIp', '');

const PUBLIC_API = new Set(['/api/auth/state', '/api/auth/login', '/api/auth/logout']);

server.addHook('onRequest', async (req, reply) => {
  req.clientIp = clientIp(req);
  const url = req.url.split('?')[0]!;
  // GitHub 웹후크는 IP 제한/로그인 없이 HMAC 서명으로만 확인
  if (url.startsWith('/api/hooks/')) return;
  if (!ipAllowed(req.clientIp)) {
    return reply.code(403).type('text/plain; charset=utf-8').send(`HROne: 이 IP(${req.clientIp})에서는 접속할 수 없습니다. Tailscale 이나 내부망으로 접속하세요.`);
  }
  if (!url.startsWith('/api/')) return;
  // 다른 사이트에서 WebSocket 을 여는 것(CSWSH) 차단
  if (url === '/api/ws') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return reply.code(403).send({ error: 'origin 불일치' });
  }
  loadSession(req);
  if (PUBLIC_API.has(url)) return;
  if (!req.user) return reply.code(401).send({ error: '로그인이 필요합니다' });
  // CSRF: 변경 요청은 커스텀 헤더 필수 (다른 사이트의 form/fetch 는 이 헤더를 못 붙인다)
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-hrone'] !== '1') {
    return reply.code(403).send({ error: '잘못된 요청 (CSRF)' });
  }
});

server.setErrorHandler((err, req, reply) => {
  const status = err instanceof HttpError ? err.status : (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) log.error(`${req.method} ${req.url}: ${errMsg(err)}`);
  reply.code(status).send({ error: errMsg(err) });
});

registerAuth(server);
registerApps(server);
registerDeploys(server);
registerDatabases(server);
registerSystem(server);
registerWs(server);

await registerWeb(server, PATHS.webDist);

// ---------- 시작 시 정리 ----------

async function reconcile() {
  await writeSlices(settings.limits(), false).catch((e) => log.warn(`slices: ${errMsg(e)}`));
  for (const app of listApps()) {
    await ensureAppIdentity(app).catch((e) => log.warn(`identity ${app.slug}: ${errMsg(e)}`));
    if (!app.deployed_sha) continue;
    await writeRuntime(app).catch((e) => log.warn(`runtime ${app.slug}: ${errMsg(e)}`));
    // 자동 시작이 꺼진 앱이 재부팅 후 꺼져 있으면 "정지" 상태로 맞춘다
    if (!app.config.autostart && app.desired_state === 'running') {
      const active = (await tryRun('systemctl', ['is-active', UNIT.app(app.slug)])).stdout.trim();
      if (active !== 'active' && active !== 'activating') setDesired(app.slug, 'stopped');
    }
  }
  for (const db of listDbs()) {
    if (!db.initialized) continue;
    await writeDbRuntime(db).catch((e) => log.warn(`db runtime ${db.slug}: ${errMsg(e)}`));
  }
  recoverOnBoot();
}

await reconcile();
startMonitor();
setInterval(() => {
  try {
    schedulerTick();
  } catch (e) {
    log.warn(`scheduler: ${errMsg(e)}`);
  }
}, 1000).unref();
setInterval(() => void pollTick().catch((e) => log.warn(`poll: ${errMsg(e)}`)), 5000).unref();
setInterval(() => void scheduledTick().catch((e) => log.warn(`backup: ${errMsg(e)}`)), 60_000).unref();

const port = settings.panel().port;
const host = process.env.HRONE_HOST ?? '0.0.0.0';
await server.listen({ port, host });
log.info(`HROne 패널 시작: http://${host}:${port} (데이터 ${DATA})`);
void notify({ kind: 'panel', title: '🟢 HROne 패널 시작', color: 'gray' }).catch(() => {});

const shutdown = async (sig: string) => {
  log.info(`${sig} → 종료`);
  await server.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
