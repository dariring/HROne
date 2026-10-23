import fs from 'node:fs';
import path from 'node:path';
import { run, sh, shq, tryRun } from '../../lib/exec.ts';
import { dbDir, UNIT } from '../../lib/paths.ts';
import type { Db, DbSecrets, MariaLimits } from '../../lib/types.ts';
import { HttpError, sleep, writeFileIfChanged } from '../../lib/util.ts';
import { ensureMariadb, mariadbBins, type MariaBins } from '../packages.ts';
import * as systemd from '../systemd.ts';
import { bindAddress, dataDir, runDir, unitOf } from './common.ts';

type Logger = (l: string) => void;

const cnfPath = (slug: string) => path.join(dbDir(slug), 'my.cnf');
const socketPath = (slug: string) => path.join(runDir(slug), 'mysqld.sock');

async function bins(): Promise<MariaBins> {
  const b = await mariadbBins();
  if (!b) throw new HttpError(500, 'MariaDB 가 설치되어 있지 않습니다');
  return b;
}

export async function ensureInstalled(onLog: Logger) {
  return ensureMariadb(onLog);
}

/** 문자열을 SQL 리터럴로 */
export function lit(s: string) {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function ident(s: string) {
  return '`' + s.replace(/`/g, '``') + '`';
}

export function configContent(db: Db) {
  const l = db.config.limits as MariaLimits;
  return [
    '# HROne 이 관리하는 파일입니다. 패널의 "제한/설정" 에서 바꾸세요.',
    '[client]',
    `socket=${socketPath(db.slug)}`,
    `port=${db.config.port}`,
    'default-character-set=utf8mb4',
    '',
    '[mysqld]',
    'user=mysql',
    `datadir=${dataDir(db.slug)}`,
    `socket=${socketPath(db.slug)}`,
    `pid-file=${path.join(runDir(db.slug), 'mysqld.pid')}`,
    `port=${db.config.port}`,
    `bind-address=${bindAddress(db.config.bind, 'mariadb')}`,
    'skip-name-resolve',
    'character-set-server=utf8mb4',
    'collation-server=utf8mb4_unicode_ci',
    `max_connections=${l.maxConnections}`,
    `max_user_connections=${l.maxUserConnections}`,
    `max_connect_errors=${l.maxConnectErrors}`,
    `wait_timeout=${l.waitTimeout}`,
    `interactive_timeout=${l.waitTimeout}`,
    `max_allowed_packet=${l.maxAllowedPacketMB}M`,
    `innodb_buffer_pool_size=${l.innodbBufferPoolMB}M`,
    `table_open_cache=${l.tableOpenCache}`,
    `thread_cache_size=${l.threadCacheSize}`,
    'open_files_limit=1048576',
    'innodb_file_per_table=1',
    'log_warnings=2',
    '',
  ].join('\n');
}

export function writeConfig(db: Db) {
  return writeFileIfChanged(cnfPath(db.slug), configContent(db), 0o644);
}

async function supportsNotify(server: string) {
  const r = await tryRun('ldd', [server]);
  return r.stdout.includes('libsystemd');
}

export async function unitContent(db: Db) {
  const b = await bins();
  const notify = await supportsNotify(b.server);
  return [
    '# HROne 이 관리하는 파일입니다.',
    '[Unit]',
    `Description=HROne MariaDB ${db.name}`,
    'After=network.target',
    '',
    '[Service]',
    `Type=${notify ? 'notify' : 'simple'}`,
    'User=mysql',
    'Group=mysql',
    `RuntimeDirectory=${path.basename(runDir(db.slug))}`,
    'RuntimeDirectoryMode=0755',
    `ExecStart=${b.server} --defaults-file=${cnfPath(db.slug)}`,
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStartSec=900',
    'TimeoutStopSec=900',
    'KillMode=process',
    'KillSignal=SIGTERM',
    'SendSIGKILL=no',
    'LimitNOFILE=1048576',
    'LimitMEMLOCK=524288',
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${db.slug}`,
    `Slice=${UNIT.dbsSlice}`,
    'CPUAccounting=yes',
    'MemoryAccounting=yes',
    ...systemd.resourceDirectives(db.config.resources),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/** root(unix_socket) 로 SQL 실행 */
export async function sql(db: Db, statement: string, opts: { database?: string; table?: boolean; timeoutMs?: number } = {}) {
  const b = await bins();
  const args = [`--defaults-file=${cnfPath(db.slug)}`, '-uroot'];
  if (opts.table) args.push('-t', '-vvv');
  else args.push('-N', '-B');
  if (opts.database) args.push('-D', opts.database);
  const r = await run(b.client, args, { input: statement, timeoutMs: opts.timeoutMs ?? 60_000, allowFail: true });
  if (r.code !== 0) {
    const raw = (r.stderr || r.stdout).trim();
    const errLines = raw.split('\n').filter((l) => l.startsWith('ERROR'));
    if (opts.table) throw new HttpError(400, raw.replace(/\nBye\s*$/, '') || 'SQL 실행 실패');
    throw new HttpError(400, (errLines.join('\n') || raw).replace(/^ERROR (\d+) \(\w+\) at line \d+: /, 'ERROR $1: ') || 'SQL 실행 실패');
  }
  return opts.table ? r.stdout.replace(/\n?Bye\s*$/, '') : r.stdout;
}

export async function rows(db: Db, statement: string) {
  const out = await sql(db, statement);
  return out
    .split('\n')
    .filter((l) => l.length)
    .map((l) => l.split('\t'));
}

async function waitReady(db: Db, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await sql(db, 'SELECT 1', { timeoutMs: 5000 });
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error('MariaDB 가 제시간에 시작되지 않았습니다. 콘솔 로그를 확인하세요.');
}

/** 데이터 폴더 초기화 + 첫 시작 + 계정 생성 */
export async function init(db: Db, secrets: DbSecrets, onLog: Logger) {
  const b = await ensureInstalled(onLog);
  const dir = dataDir(db.slug);
  fs.mkdirSync(dbDir(db.slug), { recursive: true });
  fs.chmodSync(dbDir(db.slug), 0o755);
  writeConfig(db);
  if (!fs.existsSync(path.join(dir, 'mysql'))) {
    // 이전 초기화가 중간에 실패했으면 비우고 다시
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await run('chown', ['-R', 'mysql:mysql', dir]);
    fs.chmodSync(dir, 0o750);
    onLog('데이터 폴더 초기화 (mariadb-install-db)...');
    await run(
      b.installDb,
      [
        `--defaults-file=${cnfPath(db.slug)}`,
        '--user=mysql',
        `--datadir=${dir}`,
        '--auth-root-authentication-method=socket',
        '--skip-test-db',
      ],
      { onLine: (l) => l.trim() && onLog(l), timeoutMs: 10 * 60_000 },
    );
  }
  systemd.writeUnit(unitOf(db.slug), await unitContent(db));
  await systemd.daemonReload();
  onLog('MariaDB 시작...');
  await systemd.systemctl('start', unitOf(db.slug));
  await waitReady(db);
  onLog('계정/데이터베이스 생성...');
  const c = db.config;
  await sql(
    db,
    [
      // 익명 계정이 있으면 'app'@'%' 보다 먼저 매칭되어 로그인이 실패하므로 제거
      `DELETE FROM mysql.global_priv WHERE User = '';`,
      'FLUSH PRIVILEGES;',
      `CREATE DATABASE IF NOT EXISTS ${ident(c.defaultDb)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `CREATE USER IF NOT EXISTS ${lit(c.appUser)}@'%' IDENTIFIED BY ${lit(secrets.appPassword)};`,
      `ALTER USER ${lit(c.appUser)}@'%' IDENTIFIED BY ${lit(secrets.appPassword)};`,
      `GRANT ALL PRIVILEGES ON ${ident(c.defaultDb)}.* TO ${lit(c.appUser)}@'%';`,
      `CREATE USER IF NOT EXISTS ${lit(c.adminUser)}@'%' IDENTIFIED BY ${lit(secrets.adminPassword)};`,
      `ALTER USER ${lit(c.adminUser)}@'%' IDENTIFIED BY ${lit(secrets.adminPassword)};`,
      `GRANT ALL PRIVILEGES ON *.* TO ${lit(c.adminUser)}@'%' WITH GRANT OPTION;`,
      'FLUSH PRIVILEGES;',
    ].join('\n'),
  );
}

export async function setPasswords(db: Db, secrets: DbSecrets) {
  const c = db.config;
  await sql(
    db,
    `ALTER USER ${lit(c.appUser)}@'%' IDENTIFIED BY ${lit(secrets.appPassword)};
     ALTER USER ${lit(c.adminUser)}@'%' IDENTIFIED BY ${lit(secrets.adminPassword)};
     FLUSH PRIVILEGES;`,
  );
}

/** 재시작 없이 바로 적용 */
export async function applyLimitsLive(db: Db) {
  const l = db.config.limits as MariaLimits;
  const sets: [string, number][] = [
    ['max_connections', l.maxConnections],
    ['max_user_connections', l.maxUserConnections],
    ['max_connect_errors', l.maxConnectErrors],
    ['wait_timeout', l.waitTimeout],
    ['interactive_timeout', l.waitTimeout],
    ['max_allowed_packet', l.maxAllowedPacketMB * 1024 * 1024],
    ['innodb_buffer_pool_size', l.innodbBufferPoolMB * 1024 * 1024],
    ['table_open_cache', l.tableOpenCache],
    ['thread_cache_size', l.threadCacheSize],
  ];
  const warnings: string[] = [];
  const cur = Object.fromEntries((await rows(db, `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${sets.map(([k]) => lit(k)).join(',')})`)).map(([k, v]) => [k!, v!]));
  for (const [k, v] of sets) {
    if (String(cur[k]) === String(Math.round(v))) continue;
    try {
      await sql(db, `SET GLOBAL ${k} = ${Math.round(v)};`);
    } catch (e) {
      const msg = (e as Error).message;
      // 시작할 때 0(무제한)이었던 max_user_connections 는 실행 중에 못 바꾼다 → 재시작 때 적용
      warnings.push(/1290|running with the/.test(msg) ? `${k}: 재시작하면 적용됩니다` : `${k}: ${msg}`);
    }
  }
  // 계정별 연결 제한도 같이 풀어 준다
  if (l.maxUserConnections === 0) {
    await sql(db, `ALTER USER ${lit(db.config.appUser)}@'%' WITH MAX_USER_CONNECTIONS 0;`).catch(() => {});
  }
  return warnings;
}

export async function flushHosts(db: Db) {
  await sql(db, 'FLUSH HOSTS;');
}

export async function status(db: Db) {
  const want = [
    'Threads_connected',
    'Threads_running',
    'Max_used_connections',
    'Uptime',
    'Questions',
    'Slow_queries',
    'Aborted_connects',
    'Connection_errors_max_connections',
  ];
  const vars = ['version', 'max_connections', 'max_user_connections', 'open_files_limit', 'innodb_buffer_pool_size', 'max_connect_errors', 'wait_timeout', 'max_allowed_packet'];
  const st = await rows(db, `SHOW GLOBAL STATUS WHERE Variable_name IN (${want.map(lit).join(',')})`);
  const vr = await rows(db, `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${vars.map(lit).join(',')})`);
  const out: Record<string, string> = {};
  for (const [k, v] of [...st, ...vr]) out[k!] = v ?? '';
  return out;
}

export async function listDatabases(db: Db) {
  const r = await rows(
    db,
    `SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length), 0), COUNT(t.table_name)
     FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
     WHERE s.schema_name NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
     GROUP BY s.schema_name ORDER BY s.schema_name`,
  );
  return r.map(([name, size, tables]) => ({ name: name!, size: Number(size), tables: Number(tables) }));
}

export async function listUsers(db: Db) {
  const r = await rows(db, `SELECT user, host, max_user_connections FROM mysql.user WHERE user NOT IN ('', 'mariadb.sys') ORDER BY user`);
  return r.map(([user, host, maxConn]) => ({ user: user!, host: host!, maxConnections: Number(maxConn) }));
}

const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

export async function createDatabase(db: Db, name: string, grantUser?: string) {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'DB 이름은 영문/숫자/_ 1~64자');
  await sql(db, `CREATE DATABASE IF NOT EXISTS ${ident(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  if (grantUser) await sql(db, `GRANT ALL PRIVILEGES ON ${ident(name)}.* TO ${lit(grantUser)}@'%'; FLUSH PRIVILEGES;`);
}

export async function dropDatabase(db: Db, name: string) {
  if (!NAME_RE.test(name)) throw new HttpError(400, '잘못된 DB 이름');
  await sql(db, `DROP DATABASE ${ident(name)};`);
}

export async function createUser(db: Db, user: string, password: string, databases: string[] | 'all') {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(user)) throw new HttpError(400, '계정 이름은 영문/숫자/_.- 1~80자');
  const grants =
    databases === 'all'
      ? [`GRANT ALL PRIVILEGES ON *.* TO ${lit(user)}@'%';`]
      : databases.map((d) => {
          if (!NAME_RE.test(d)) throw new HttpError(400, `잘못된 DB 이름: ${d}`);
          return `GRANT ALL PRIVILEGES ON ${ident(d)}.* TO ${lit(user)}@'%';`;
        });
  await sql(db, [`CREATE USER ${lit(user)}@'%' IDENTIFIED BY ${lit(password)};`, ...grants, 'FLUSH PRIVILEGES;'].join('\n'));
}

export async function dropUser(db: Db, user: string, host: string) {
  if (user === db.config.adminUser || user === 'root') throw new HttpError(400, '관리자/루트 계정은 지울 수 없습니다');
  await sql(db, `DROP USER ${lit(user)}@${lit(host)};`);
}

export async function setUserPassword(db: Db, user: string, host: string, password: string) {
  await sql(db, `ALTER USER ${lit(user)}@${lit(host)} IDENTIFIED BY ${lit(password)}; FLUSH PRIVILEGES;`);
}

export async function query(db: Db, text: string, database?: string) {
  if (database && !NAME_RE.test(database)) throw new HttpError(400, '잘못된 DB 이름');
  return sql(db, text, { database, table: true, timeoutMs: 5 * 60_000 });
}

/** 계정과 권한을 CREATE USER / GRANT 문으로 (mariadb-dump --system=users 는 서버 collation 에 따라 실패해서 직접 만든다) */
async function usersSql(db: Db) {
  const users = (await rows(db, 'SELECT user, host, is_role FROM mysql.user')).filter(
    ([u, , role]) => u && !['root', 'mariadb.sys', 'mysql', 'PUBLIC'].includes(u) && role !== 'Y',
  );
  const out = ['', '-- HROne: 계정 / 권한'];
  for (const [u, h] of users) {
    const who = `${lit(u!)}@${lit(h!)}`;
    const create = (await rows(db, `SHOW CREATE USER ${who}`))[0]?.[0];
    if (create) out.push(create.replace(/^CREATE USER /, 'CREATE USER IF NOT EXISTS ') + ';');
    for (const [g] of await rows(db, `SHOW GRANTS FOR ${who}`)) if (g) out.push(g + ';');
  }
  out.push('FLUSH PRIVILEGES;', '');
  return out.join('\n');
}

export async function backup(db: Db, file: string) {
  const b = await bins();
  const dbs = (await listDatabases(db)).map((d) => d.name);
  const args = [
    `--defaults-file=${shq(cnfPath(db.slug))}`,
    '-uroot',
    '--single-transaction',
    '--routines',
    '--events',
    '--triggers',
    '--hex-blob',
    '--add-drop-database',
  ];
  const usersFile = `${file}.users.sql`;
  fs.writeFileSync(usersFile, await usersSql(db), { mode: 0o600 });
  try {
    const dump = dbs.length ? `${shq(b.dump)} ${args.join(' ')} --databases ${dbs.map(shq).join(' ')}` : 'true';
    await sh(`set -o pipefail; { ${dump}; cat ${shq(usersFile)}; } | gzip -c > ${shq(file)}`, { timeoutMs: 6 * 3600_000 });
  } finally {
    fs.rmSync(usersFile, { force: true });
  }
}

export async function restore(db: Db, file: string, onLog: Logger) {
  const b = await bins();
  onLog('SQL 덤프를 복원하는 중...');
  await sh(`set -o pipefail; gzip -dc ${shq(file)} | ${shq(b.client)} --defaults-file=${shq(cnfPath(db.slug))} -uroot`, {
    timeoutMs: 6 * 3600_000,
  });
  await sql(db, 'FLUSH PRIVILEGES;');
}
