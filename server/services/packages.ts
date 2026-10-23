import fs from 'node:fs';
import { run, tryRun, which } from '../lib/exec.ts';
import { KeyedMutex } from '../lib/util.ts';

const mutex = new KeyedMutex();
type Logger = (line: string) => void;

export async function isInstalled(pkg: string) {
  const r = await tryRun('dpkg-query', ['-W', '-f=${Status}', pkg]);
  return r.code === 0 && r.stdout.includes('install ok installed');
}

export async function hasCandidate(pkg: string) {
  const r = await tryRun('apt-cache', ['policy', pkg]);
  const m = r.stdout.match(/Candidate:\s*(\S+)/);
  return !!m && m[1] !== '(none)';
}

let updatedAt = 0;

export function aptInstall(pkgs: string[], onLog: Logger = () => {}) {
  return mutex.run('apt', async () => {
    const missing: string[] = [];
    for (const p of pkgs) if (!(await isInstalled(p))) missing.push(p);
    if (!missing.length) return;
    const env = { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'a' };
    const onLine = (l: string) => l.trim() && onLog(l);
    if (Date.now() - updatedAt > 30 * 60_000) {
      onLog('apt-get update...');
      await run('apt-get', ['update', '-q'], { env, onLine, timeoutMs: 10 * 60_000 });
      updatedAt = Date.now();
    }
    onLog(`설치: ${missing.join(' ')}`);
    await run(
      'apt-get',
      ['install', '-y', '-q', '--no-install-recommends', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', ...missing],
      { env, onLine, timeoutMs: 30 * 60_000 },
    );
  });
}

/** 패키지 설치 직후 배포판 기본 서비스는 끄고, HROne 인스턴스만 돌린다 */
async function disableDefaultService(unit: string) {
  await tryRun('systemctl', ['disable', '--now', unit]);
}

export interface MariaBins {
  server: string;
  installDb: string;
  client: string;
  dump: string;
  version: string;
}

export async function mariadbBins(): Promise<MariaBins | null> {
  const server = ['/usr/sbin/mariadbd', '/usr/sbin/mysqld'].find((p) => fs.existsSync(p));
  const installDb = (await which('mariadb-install-db')) ?? (await which('mysql_install_db'));
  const client = (await which('mariadb')) ?? (await which('mysql'));
  const dump = (await which('mariadb-dump')) ?? (await which('mysqldump'));
  if (!server || !installDb || !client || !dump) return null;
  const v = await tryRun(server, ['--version']);
  return { server, installDb, client, dump, version: (v.stdout.match(/Ver\s+(\S+)/)?.[1] ?? '').replace(/-.*$/, '') };
}

export function ensureMariadb(onLog: Logger = () => {}) {
  return mutex.run('mariadb', async () => {
    let bins = await mariadbBins();
    if (bins) return bins;
    await aptInstall(['mariadb-server', 'mariadb-client'], onLog);
    await disableDefaultService('mariadb.service');
    bins = await mariadbBins();
    if (!bins) throw new Error('MariaDB 설치 후에도 실행 파일을 찾지 못했습니다');
    return bins;
  });
}

export interface RedisBins {
  server: string;
  cli: string;
  flavor: 'redis' | 'valkey';
  version: string;
}

export async function redisBins(): Promise<RedisBins | null> {
  for (const flavor of ['redis', 'valkey'] as const) {
    const server = await which(`${flavor}-server`);
    const cli = await which(`${flavor}-cli`);
    if (server && cli) {
      const v = await tryRun(server, ['--version']);
      return { server, cli, flavor, version: v.stdout.match(/v=(\S+)/)?.[1] ?? '' };
    }
  }
  return null;
}

export function ensureRedis(onLog: Logger = () => {}) {
  return mutex.run('redis', async () => {
    let bins = await redisBins();
    if (bins) return bins;
    if (await hasCandidate('redis-server')) {
      await aptInstall(['redis-server', 'redis-tools'], onLog);
      await disableDefaultService('redis-server.service');
    } else {
      await aptInstall(['valkey-server', 'valkey-tools'], onLog);
      await disableDefaultService('valkey-server.service');
    }
    bins = await redisBins();
    if (!bins) throw new Error('Redis 설치 후에도 실행 파일을 찾지 못했습니다');
    return bins;
  });
}
