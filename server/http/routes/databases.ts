import type { FastifyInstance } from 'fastify';
import { audit } from '../../lib/audit.ts';
import { randomPassword } from '../../lib/crypto.ts';
import { UNIT } from '../../lib/paths.ts';
import type { Db } from '../../lib/types.ts';
import { HttpError } from '../../lib/util.ts';
import * as apps from '../../services/apps.ts';
import { backupDatabase, listBackups } from '../../services/backups.ts';
import * as dbs from '../../services/databases/index.ts';
import { linksForDb } from '../../services/databases/links.ts';
import { runningJobFor } from '../../services/jobs.ts';
import { getStatus, unitHistoryOf } from '../../services/monitor.ts';
import { mariadbBins, redisBins } from '../../services/packages.ts';
import { actor, reauth } from '../auth.ts';
import { clearLogs, recentLogs, sendLogs } from './apps.ts';

type Body = Record<string, any>;

export function dbSummary(db: Db) {
  const job = runningJobFor('db-init', db.slug) ?? runningJobFor('db-restore', db.slug);
  return {
    id: db.id,
    slug: db.slug,
    name: db.name,
    type: db.type,
    port: db.config.port,
    bind: db.config.bind,
    autostart: db.config.autostart,
    initialized: !!db.initialized,
    desiredState: db.desired_state,
    status: getStatus(UNIT.db(db.slug)),
    job: job ? { id: job.id, kind: job.kind, title: job.title } : null,
    linkedApps: linksForDb(db.id).map((l) => {
      const a = apps.getAppById(l.app_id);
      return { slug: a?.slug, name: a?.name, prefix: l.prefix };
    }),
  };
}

/** 앱들의 env 파일을 다시 써서 DB 변경을 반영 (재시작은 사용자가) */
async function refreshApps(appIds: number[]) {
  for (const id of appIds) {
    const app = apps.getAppById(id);
    if (app?.deployed_sha) await apps.writeRuntime(app);
  }
}

export function registerDatabases(server: FastifyInstance) {
  server.get('/api/databases', async () => dbs.listDbs().map(dbSummary));

  server.get('/api/databases/engines', async () => {
    const m = await mariadbBins();
    const r = await redisBins();
    return { mariadb: m ? m.version : null, redis: r ? `${r.flavor} ${r.version}` : null };
  });

  server.post('/api/databases', async (req) => {
    const b = (req.body ?? {}) as Body;
    const r = await dbs.createDatabase(
      { slug: b.slug, name: b.name, type: b.type, port: b.port ? Number(b.port) : null, bind: b.bind, autostart: b.autostart !== false, resources: b.resources },
      actor(req),
    );
    return { db: dbSummary(r.db), jobId: r.jobId };
  });

  server.get('/api/databases/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const db = dbs.getDb(slug);
    return {
      ...dbSummary(db),
      config: db.config,
      createdAt: db.created_at,
      history: unitHistoryOf(UNIT.db(slug)),
      dataDir: dbs.dataDir(slug),
    };
  });

  server.get('/api/databases/:slug/credentials', async (req) => {
    const { slug } = req.params as { slug: string };
    const db = dbs.getDb(slug);
    const s = dbs.dbSecrets(slug);
    audit(actor(req), 'db.reveal', slug);
    if (db.type === 'mariadb') {
      return {
        admin: { user: db.config.adminUser, password: s.adminPassword },
        app: { user: db.config.appUser, password: s.appPassword, database: db.config.defaultDb },
        url: `mysql://${db.config.appUser}:${s.appPassword}@127.0.0.1:${db.config.port}/${db.config.defaultDb}`,
      };
    }
    return { admin: { user: 'default', password: s.adminPassword }, url: `redis://:${s.adminPassword}@127.0.0.1:${db.config.port}/0` };
  });

  server.patch('/api/databases/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const r = await dbs.updateDatabase(slug, (req.body ?? {}) as Body, actor(req));
    await refreshApps(r.linkedApps);
    return { db: dbSummary(r.db), restarted: r.restarted };
  });

  server.post('/api/databases/:slug/action', async (req) => {
    const { slug } = req.params as { slug: string };
    const { action } = (req.body ?? {}) as Body;
    if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, '알 수 없는 동작');
    await dbs.dbLifecycle(slug, action, actor(req));
    return { ok: true };
  });

  server.post('/api/databases/:slug/init', async (req) => {
    const { slug } = req.params as { slug: string };
    const job = dbs.initialize(slug);
    audit(actor(req), 'db.init', slug);
    return { jobId: job.id };
  });

  server.get('/api/databases/:slug/status', async (req) => {
    const { slug } = req.params as { slug: string };
    return { status: await dbs.dbStatus(slug), unit: getStatus(UNIT.db(slug)) };
  });

  server.put('/api/databases/:slug/limits', async (req) => {
    const { slug } = req.params as { slug: string };
    const r = await dbs.updateLimits(slug, (req.body ?? {}) as Body, actor(req));
    return { limits: r.db.config.limits, warnings: r.warnings };
  });

  server.post('/api/databases/:slug/unlimit', async (req) => {
    const { slug } = req.params as { slug: string };
    const r = await dbs.unlimit(slug, actor(req));
    return { limits: r.db.config.limits, warnings: r.warnings };
  });

  server.post('/api/databases/:slug/flush-hosts', async (req) => {
    const { slug } = req.params as { slug: string };
    const db = dbs.getDb(slug);
    if (db.type !== 'mariadb') throw new HttpError(400, 'MariaDB 전용');
    await dbs.maria.flushHosts(db);
    audit(actor(req), 'db.flush_hosts', slug);
    return { ok: true };
  });

  server.post('/api/databases/:slug/password', async (req) => {
    const { slug } = req.params as { slug: string };
    const which = (req.body as Body)?.which === 'app' ? 'app' : 'admin';
    const r = await dbs.rotatePassword(slug, which, actor(req));
    await refreshApps(r.linkedApps);
    return { ok: true, linkedApps: r.linkedApps.length };
  });

  // ----- MariaDB: 스키마 / 계정 -----

  const maria = (slug: string) => {
    const db = dbs.getDb(slug);
    if (db.type !== 'mariadb') throw new HttpError(400, 'MariaDB 전용 기능입니다');
    return db;
  };

  server.get('/api/databases/:slug/schemas', async (req) => {
    const { slug } = req.params as { slug: string };
    return dbs.maria.listDatabases(maria(slug));
  });

  // ----- 데이터 보기 (읽기 전용) -----

  server.get('/api/databases/:slug/schemas/:schema/tables', async (req) => {
    const { slug, schema } = req.params as { slug: string; schema: string };
    return dbs.maria.listTables(maria(slug), schema);
  });

  server.get('/api/databases/:slug/schemas/:schema/tables/:table/rows', async (req) => {
    const { slug, schema, table } = req.params as { slug: string; schema: string; table: string };
    const qs = (req.query ?? {}) as Body;
    return dbs.maria.browseRows(maria(slug), schema, table, {
      page: Number(qs.page ?? 0),
      size: Number(qs.size ?? 50),
      order: qs.order ? String(qs.order) : undefined,
      dir: qs.dir === 'desc' ? 'desc' : 'asc',
      filterCol: qs.fcol ? String(qs.fcol) : undefined,
      filter: qs.q ? String(qs.q).slice(0, 500) : undefined,
    });
  });

  server.post('/api/databases/:slug/schemas', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const db = maria(slug);
    await dbs.maria.createDatabase(db, String(b.name ?? ''), b.grantApp ? db.config.appUser : undefined);
    audit(actor(req), 'db.schema_create', slug, { name: b.name });
    return { ok: true };
  });

  server.post('/api/databases/:slug/schemas/:name/drop', async (req) => {
    const { slug, name } = req.params as { slug: string; name: string };
    const b = (req.body ?? {}) as Body;
    if (b.confirm !== name) throw new HttpError(400, '확인용 이름이 일치하지 않습니다');
    reauth(req, b.password, b.totp);
    await backupDatabase(maria(slug), 'manual', `DB ${name} 삭제 전 자동 백업`);
    await dbs.maria.dropDatabase(maria(slug), name);
    audit(actor(req), 'db.schema_drop', slug, { name });
    return { ok: true };
  });

  server.get('/api/databases/:slug/users', async (req) => {
    const { slug } = req.params as { slug: string };
    return dbs.maria.listUsers(maria(slug));
  });

  server.post('/api/databases/:slug/users', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const password = typeof b.password === 'string' && b.password.length >= 8 ? b.password : randomPassword(24);
    const scope = b.all ? 'all' : Array.isArray(b.databases) ? b.databases.map(String) : [];
    await dbs.maria.createUser(maria(slug), String(b.user ?? ''), password, scope);
    audit(actor(req), 'db.user_create', slug, { user: b.user });
    return { user: b.user, password };
  });

  server.post('/api/databases/:slug/users/:user/password', async (req) => {
    const { slug, user } = req.params as { slug: string; user: string };
    const b = (req.body ?? {}) as Body;
    const password = typeof b.password === 'string' && b.password.length >= 8 ? b.password : randomPassword(24);
    await dbs.maria.setUserPassword(maria(slug), user, String(b.host ?? '%'), password);
    audit(actor(req), 'db.user_password', slug, { user });
    return { password };
  });

  server.post('/api/databases/:slug/users/:user/drop', async (req) => {
    const { slug, user } = req.params as { slug: string; user: string };
    const b = (req.body ?? {}) as Body;
    await dbs.maria.dropUser(maria(slug), user, String(b.host ?? '%'));
    audit(actor(req), 'db.user_drop', slug, { user });
    return { ok: true };
  });

  // ----- 쿼리 콘솔 -----

  server.post('/api/databases/:slug/query', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    const db = dbs.getDb(slug);
    const text = String(b.text ?? '').trim();
    if (!text) throw new HttpError(400, '실행할 내용을 입력하세요');
    const started = Date.now();
    const out =
      db.type === 'mariadb'
        ? await dbs.maria.query(db, text, b.database ? String(b.database) : undefined)
        : await dbs.redis.query(db, dbs.dbSecrets(slug), text, Number(b.database ?? 0) || 0);
    audit(actor(req), 'db.query', slug, text.slice(0, 300));
    return { output: out, ms: Date.now() - started };
  });

  // ----- 로그 -----

  server.get('/api/databases/:slug/logs', async (req) => {
    const { slug } = req.params as { slug: string };
    dbs.getDbRow(slug);
    return recentLogs(UNIT.db(slug), Number((req.query as Body).lines ?? 500));
  });

  server.get('/api/databases/:slug/logs/download', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    dbs.getDbRow(slug);
    await sendLogs(reply, UNIT.db(slug), `db-${slug}`);
  });

  server.post('/api/databases/:slug/logs/clear', async (req) => {
    const { slug } = req.params as { slug: string };
    dbs.getDbRow(slug);
    clearLogs(UNIT.db(slug));
    return { ok: true };
  });

  // ----- 삭제 (2단계 확인) -----

  server.post('/api/databases/:slug/terminate', async (req) => {
    const { slug } = req.params as { slug: string };
    const b = (req.body ?? {}) as Body;
    dbs.getDb(slug);
    if (b.confirm !== slug) throw new HttpError(400, '확인용 DB ID 가 일치하지 않습니다');
    reauth(req, b.password, b.totp);
    const r = await dbs.terminateDatabase(slug, actor(req), b.backup !== false ? (db) => backupDatabase(db, 'terminate') : null);
    await refreshApps(r.linkedApps);
    return { ok: true, backupFile: r.backupFile };
  });

  server.get('/api/databases/:slug/backups', async (req) => {
    const { slug } = req.params as { slug: string };
    return listBackups('database', slug);
  });
}
