import fs from 'node:fs';
import path from 'node:path';
import { run, sh, shq, tryRun } from '../../lib/exec.ts';
import { dbDir, UNIT } from '../../lib/paths.ts';
import type { Db, DbSecrets, RedisLimits } from '../../lib/types.ts';
import { HttpError, sleep, writeFileIfChanged } from '../../lib/util.ts';
import { ensureRedis, redisBins, type RedisBins } from '../packages.ts';
import * as systemd from '../systemd.ts';
import { bindAddress, dataDir, unitOf } from './common.ts';

type Logger = (l: string) => void;

const confPath = (slug: string) => path.join(dbDir(slug), 'redis.conf');

async function bins(): Promise<RedisBins> {
  const b = await redisBins();
  if (!b) throw new HttpError(500, 'Redis 가 설치되어 있지 않습니다');
  return b;
}

export async function ensureInstalled(onLog: Logger) {
  return ensureRedis(onLog);
}

function serviceUser(b: RedisBins) {
  return b.flavor === 'valkey' ? 'valkey' : 'redis';
}

export function configContent(db: Db, secrets: DbSecrets, overrides: Partial<RedisLimits> = {}) {
  const l = { ...(db.config.limits as RedisLimits), ...overrides };
  return [
    '# HROne 이 관리하는 파일입니다. 패널의 "제한/설정" 에서 바꾸세요.',
    `bind ${bindAddress(db.config.bind, 'redis')}`,
    `port ${db.config.port}`,
    'protected-mode yes',
    `requirepass "${secrets.adminPassword}"`,
    `dir ${dataDir(db.slug)}`,
    'dbfilename dump.rdb',
    `appendonly ${l.appendonly ? 'yes' : 'no'}`,
    'appendfsync everysec',
    `save "${l.save.replace(/"/g, '')}"`,
    `maxclients ${l.maxClients}`,
    `maxmemory ${l.maxMemoryMB > 0 ? `${l.maxMemoryMB}mb` : '0'}`,
    `maxmemory-policy ${l.maxMemoryPolicy}`,
    `timeout ${l.timeout}`,
    'tcp-keepalive 300',
    'tcp-backlog 4096',
    'daemonize no',
    'supervised systemd',
    'logfile ""',
    'databases 16',
    '',
  ].join('\n');
}

export async function writeConfig(db: Db, secrets: DbSecrets, overrides: Partial<RedisLimits> = {}) {
  const b = await bins();
  const changed = writeFileIfChanged(confPath(db.slug), configContent(db, secrets, overrides), 0o640);
  await run('chown', [`root:${serviceUser(b)}`, confPath(db.slug)]);
  return changed;
}

export async function unitContent(db: Db) {
  const b = await bins();
  const ldd = await tryRun('ldd', [b.server]);
  const notify = ldd.stdout.includes('libsystemd');
  const user = serviceUser(b);
  return [
    '# HROne 이 관리하는 파일입니다.',
    '[Unit]',
    `Description=HROne Redis ${db.name}`,
    'After=network.target',
    '',
    '[Service]',
    `Type=${notify ? 'notify' : 'simple'}`,
    `User=${user}`,
    `Group=${user}`,
    `ExecStart=${b.server} ${confPath(db.slug)}`,
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStartSec=300',
    'TimeoutStopSec=120',
    'LimitNOFILE=1048576',
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${db.slug}`,
    `Slice=${UNIT.dbsSlice}`,
    ...systemd.accountingDirectives(),
    ...systemd.resourceDirectives(db.config.resources),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/** redis-cli 로 명령 실행. raw=true 면 기계용 출력 */
export async function cli(db: Db, secrets: DbSecrets, args: string[], raw = true, timeoutMs = 30_000) {
  const b = await bins();
  const base = ['-h', '127.0.0.1', '-p', String(db.config.port), '--no-auth-warning'];
  const r = await run(b.cli, [...base, raw ? '--raw' : '--no-raw', ...args], {
    env: { REDISCLI_AUTH: secrets.adminPassword },
    timeoutMs,
    allowFail: true,
  });
  const out = r.stdout.trim();
  if (r.code !== 0 || /^(ERR|WRONGPASS|NOAUTH|Could not connect)/.test(out)) throw new HttpError(400, out || r.stderr.trim() || 'redis-cli 실패');
  return r.stdout;
}

async function waitReady(db: Db, secrets: DbSecrets, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = await cli(db, secrets, ['PING'], true, 5000);
      if (out.trim() === 'PONG') return;
    } catch {
      /* 아직 */
    }
    await sleep(500);
  }
  throw new Error('Redis 가 제시간에 시작되지 않았습니다');
}

export async function init(db: Db, secrets: DbSecrets, onLog: Logger) {
  const b = await ensureInstalled(onLog);
  fs.mkdirSync(dbDir(db.slug), { recursive: true });
  fs.chmodSync(dbDir(db.slug), 0o755);
  const dir = dataDir(db.slug);
  fs.mkdirSync(dir, { recursive: true });
  await run('chown', ['-R', `${serviceUser(b)}:${serviceUser(b)}`, dir]);
  fs.chmodSync(dir, 0o750);
  await writeConfig(db, secrets);
  systemd.writeUnit(unitOf(db.slug), await unitContent(db));
  await systemd.daemonReload();
  onLog('Redis 시작...');
  await systemd.systemctl('start', unitOf(db.slug));
  await waitReady(db, secrets);
}

export async function applyLimitsLive(db: Db, secrets: DbSecrets) {
  const l = db.config.limits as RedisLimits;
  const sets: [string, string][] = [
    ['maxclients', String(l.maxClients)],
    ['maxmemory', l.maxMemoryMB > 0 ? `${l.maxMemoryMB}mb` : '0'],
    ['maxmemory-policy', l.maxMemoryPolicy],
    ['timeout', String(l.timeout)],
    ['appendonly', l.appendonly ? 'yes' : 'no'],
    ['save', l.save],
  ];
  const warnings: string[] = [];
  for (const [k, v] of sets) {
    try {
      await cli(db, secrets, ['CONFIG', 'SET', k, v]);
    } catch (e) {
      warnings.push(`${k}: ${(e as Error).message}`);
    }
  }
  return warnings;
}

export async function setPassword(db: Db, oldSecrets: DbSecrets, newSecrets: DbSecrets) {
  await cli(db, oldSecrets, ['CONFIG', 'SET', 'requirepass', newSecrets.adminPassword]);
  await writeConfig(db, newSecrets);
}

export function parseInfo(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf(':');
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}

export async function status(db: Db, secrets: DbSecrets) {
  const info = parseInfo(await cli(db, secrets, ['INFO']));
  const keyspace: Record<string, number> = {};
  for (const [k, v] of Object.entries(info)) {
    const m = k.match(/^db(\d+)$/);
    if (m) keyspace[k] = Number(v.match(/keys=(\d+)/)?.[1] ?? 0);
  }
  let maxclients = info.maxclients;
  if (!maxclients) {
    const r = await cli(db, secrets, ['CONFIG', 'GET', 'maxclients']).catch(() => '');
    maxclients = r.split('\n')[1]?.trim() ?? '';
  }
  return {
    version: info.redis_version ?? info.valkey_version ?? '',
    uptime: Number(info.uptime_in_seconds ?? 0),
    connectedClients: Number(info.connected_clients ?? 0),
    maxClients: Number(maxclients || 0),
    blockedClients: Number(info.blocked_clients ?? 0),
    rejectedConnections: Number(info.rejected_connections ?? 0),
    usedMemory: Number(info.used_memory ?? 0),
    usedMemoryPeak: Number(info.used_memory_peak ?? 0),
    maxMemory: Number(info.maxmemory ?? 0),
    totalCommands: Number(info.total_commands_processed ?? 0),
    opsPerSec: Number(info.instantaneous_ops_per_sec ?? 0),
    aofEnabled: info.aof_enabled === '1',
    lastSave: Number(info.rdb_last_save_time ?? 0) * 1000,
    keyspace,
  };
}

/** 콘솔 입력을 인자로 나눈다 (따옴표 지원) */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === '\\' && i + 1 < input.length) {
        const n = input[++i]!;
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** redis-cli 가 "\xec\x95..." 로 이스케이프한 UTF-8 바이트를 다시 글자로 */
export function unescapeUtf8(s: string) {
  return s.replace(/(?:\\x[0-9a-f]{2})+/g, (m) => {
    const buf = Buffer.from(m.split('\\x').filter(Boolean).map((h) => parseInt(h, 16)));
    const str = buf.toString('utf8');
    return str.includes('\uFFFD') ? m : str;
  });
}

export async function query(db: Db, secrets: DbSecrets, text: string, database = 0) {
  const results: string[] = [];
  for (const line of text.split('\n')) {
    const args = splitArgs(line.trim());
    if (!args.length) continue;
    const out = await cli(db, secrets, ['-n', String(database), ...args], false, 60_000).catch((e: Error) => `(오류) ${e.message}`);
    results.push(`> ${line.trim()}\n${unescapeUtf8(out.trimEnd())}`);
  }
  return results.join('\n\n');
}

export async function backup(db: Db, secrets: DbSecrets, file: string) {
  const b = await bins();
  const tmp = `${file}.rdb`;
  try {
    await run(b.cli, ['-h', '127.0.0.1', '-p', String(db.config.port), '--no-auth-warning', '--rdb', tmp], {
      env: { REDISCLI_AUTH: secrets.adminPassword },
      timeoutMs: 3 * 3600_000,
    });
    await sh(`gzip -c ${shq(tmp)} > ${shq(file)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** RDB 복원: 정지 → dump.rdb 교체 → AOF 끄고 시작 → AOF 다시 켜서 재작성 */
export async function restore(db: Db, secrets: DbSecrets, file: string, onLog: Logger) {
  const b = await bins();
  const user = serviceUser(b);
  const dir = dataDir(db.slug);
  const l = db.config.limits as RedisLimits;
  onLog('Redis 정지...');
  await systemd.systemctl('stop', unitOf(db.slug));
  fs.rmSync(path.join(dir, 'appendonlydir'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'appendonly.aof'), { force: true });
  await sh(`gzip -dc ${shq(file)} > ${shq(path.join(dir, 'dump.rdb'))}`);
  await run('chown', [`${user}:${user}`, path.join(dir, 'dump.rdb')]);
  await writeConfig(db, secrets, { appendonly: false });
  onLog('Redis 시작 (RDB 로드)...');
  await systemd.systemctl('start', unitOf(db.slug));
  await waitReady(db, secrets, 10 * 60_000);
  if (l.appendonly) {
    onLog('AOF 다시 켜는 중...');
    await cli(db, secrets, ['CONFIG', 'SET', 'appendonly', 'yes']);
  }
  await writeConfig(db, secrets);
}
