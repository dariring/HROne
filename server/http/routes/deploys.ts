import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appDataDir } from '../../lib/paths.ts';
import type { FastifyInstance } from 'fastify';
import { audit } from '../../lib/audit.ts';
import { errMsg, log } from '../../lib/log.ts';
import { HttpError } from '../../lib/util.ts';
import * as apps from '../../services/apps.ts';
import * as deploy from '../../services/deploy.ts';
import { checkApp } from '../../services/watcher.ts';
import { actor } from '../auth.ts';

type Body = Record<string, any>;

function withApp(d: deploy.Deploy) {
  const app = apps.getAppById(d.app_id);
  return { ...d, appSlug: app?.slug, appName: app?.name };
}

export function registerDeploys(server: FastifyInstance) {
  server.get('/api/apps/:slug/deploys', async (req) => {
    const { slug } = req.params as { slug: string };
    const app = apps.getApp(slug);
    return deploy.listDeploys(app.id, Number((req.query as Body).limit ?? 50));
  });

  server.post('/api/apps/:slug/deploy', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const sha = typeof b.sha === 'string' && /^[0-9a-f]{7,40}$/.test(b.sha) ? b.sha : null;
    if (b.clean) {
      // 의존성 해시 / 가상환경 표시를 지워 다음 배포에서 새로 설치되게 한다 (실행 중인 앱은 그대로)
      fs.rmSync(path.join(appDataDir(slug), 'deps.hash'), { force: true });
      fs.rmSync(path.join(apps.venvDir(slug), '.hrone-python'), { force: true });
    }
    const id = await deploy.requestDeploy(slug, { trigger: b.trigger === 'config' ? 'config' : 'manual', sha, actor: actor(req) });
    return { id };
  });

  server.post('/api/apps/:slug/check', async (req) => {
    const { slug } = req.params as { slug: string };
    const app = apps.getApp(slug);
    if (!app.deployed_sha) throw new HttpError(409, '첫 배포가 끝난 뒤에 확인할 수 있습니다');
    const sha = await checkApp(app);
    return { sha, upToDate: sha === app.deployed_sha };
  });

  server.post('/api/apps/:slug/rollback', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const target = deploy.getDeploy(Number(b.deployId));
    const app = apps.getApp(slug);
    if (target.app_id !== app.id || !target.to_sha) throw new HttpError(400, '이 앱의 배포가 아닙니다');
    if (target.status !== 'success') throw new HttpError(400, '성공한 배포로만 되돌릴 수 있습니다');
    const id = await deploy.requestDeploy(slug, { trigger: 'rollback', sha: target.to_sha, actor: actor(req) });
    return { id };
  });

  server.get('/api/deploys/open', async () => deploy.openDeploys().map(withApp));
  server.get('/api/deploys/recent', async (req) => deploy.recentDeploys(Number((req.query as Body).limit ?? 20)).map(withApp));

  server.get('/api/deploys/:id', async (req) => {
    const { id } = req.params as { id: string };
    const d = deploy.getDeploy(Number(id));
    return { ...withApp(d), log: deploy.readLog(d.id) };
  });

  server.get('/api/deploys/:id/diff', async (req) => {
    const { id } = req.params as { id: string };
    const file = (req.query as Body).file;
    return deploy.diffFor(deploy.getDeploy(Number(id)), typeof file === 'string' ? file : null);
  });

  server.post('/api/deploys/:id/approve', async (req) => {
    deploy.approve(Number((req.params as { id: string }).id), actor(req));
    return { ok: true };
  });

  // 지연 배포를 기다리지 않고 바로
  server.post('/api/deploys/:id/run-now', async (req) => {
    deploy.approve(Number((req.params as { id: string }).id), actor(req));
    return { ok: true };
  });

  server.post('/api/deploys/:id/reject', async (req) => {
    deploy.reject(Number((req.params as { id: string }).id), actor(req));
    return { ok: true };
  });

  // ----- GitHub 웹후크 (인증 대신 HMAC 서명 확인) -----

  server.post('/api/hooks/github/:slug', { config: { rawBody: true } }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    let app;
    try {
      app = apps.getApp(slug);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    const secret = apps.getSecrets(slug).webhookSecret;
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      audit({ username: 'github', ip: req.clientIp }, 'hook.bad_signature', slug);
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const event = String(req.headers['x-github-event'] ?? '');
    if (event === 'ping') return { ok: true, pong: true };
    if (event !== 'push') return { ok: true, ignored: event };
    const body = (req.body ?? {}) as { ref?: string; after?: string };
    if (body.ref !== `refs/heads/${app.config.branch}`) return { ok: true, ignored: `branch ${body.ref}` };
    if (!app.deployed_sha) return { ok: true, ignored: 'not deployed yet' };
    // GitHub 는 10초 안에 응답을 원하므로 확인은 백그라운드로
    checkApp(app, 'webhook').catch((e) => log.warn(`webhook check ${slug}: ${errMsg(e)}`));
    return { ok: true, queued: true };
  });
}
