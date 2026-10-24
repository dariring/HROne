import fs from 'node:fs';
import path from 'node:path';
import { run, tryRun, which } from '../lib/exec.ts';
import { log } from '../lib/log.ts';
import { PATHS } from '../lib/paths.ts';
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
    if (!bins) {
      await aptInstall(['mariadb-server', 'mariadb-client'], onLog);
      await disableDefaultService('mariadb.service');
      bins = await mariadbBins();
      if (!bins) throw new Error('MariaDB 설치 후에도 실행 파일을 찾지 못했습니다');
    }
    if (await ensureMariadbAppArmor()) onLog('AppArmor: HROne DB 폴더를 mariadbd 프로필에 허용했습니다');
    return bins;
  });
}

const AA_PROFILE = '/etc/apparmor.d/mariadbd';
const AA_LOCAL = '/etc/apparmor.d/local/mariadbd';

/** mariadbd AppArmor 프로필에 넣을 HROne 경로 (프로필이 공식으로 열어 둔 local/mariadbd 에 쓴다) */
export function mariadbAppArmorRules(databasesDir: string) {
  return [
    '# >>> HROne (패널이 관리하는 MariaDB 인스턴스 경로. 이 사이는 HROne 이 다시 씁니다)',
    `${databasesDir}/ r,`,
    `${databasesDir}/*/ r,`,
    `${databasesDir}/*/my.cnf r,`,
    `${databasesDir}/*/data/ r,`,
    `${databasesDir}/*/data/** rwk,`,
    '/run/hrone-db-*/ rw,',
    '/run/hrone-db-*/** rwk,',
    '# <<< HROne',
    '',
  ].join('\n');
}

/** 기존 local 파일에서 HROne 구역만 바꾼다 (사용자가 넣은 다른 줄은 그대로) */
export function mergeAppArmorLocal(current: string, block: string) {
  const re = /# >>> HROne[^\n]*\n[\s\S]*?# <<< HROne\n?/;
  if (re.test(current)) return current.replace(re, block);
  return current + (current && !current.endsWith('\n') ? '\n' : '') + block;
}

/**
 * Ubuntu 26.04 부터 mariadb-server 가 강제 모드 AppArmor 프로필(mariadbd)을 같이 설치해서
 * /var/lib/mysql 밖의 데이터 폴더(우리 /var/lib/hrone/databases/*)를 읽지 못한다. 바뀐 게 있을 때만 다시 불러온다.
 */
export async function ensureMariadbAppArmor() {
  if (!fs.existsSync(AA_PROFILE)) return false;
  const current = fs.existsSync(AA_LOCAL) ? fs.readFileSync(AA_LOCAL, 'utf8') : '';
  const next = mergeAppArmorLocal(current, mariadbAppArmorRules(PATHS.databases));
  if (next === current) return false;
  fs.mkdirSync(path.dirname(AA_LOCAL), { recursive: true });
  fs.writeFileSync(AA_LOCAL, next);
  const r = await tryRun('apparmor_parser', ['-r', '-T', '-W', AA_PROFILE]);
  if (r.code !== 0) log.warn(`AppArmor 프로필을 다시 불러오지 못했습니다: ${(r.stderr || r.stdout).trim()}`);
  return true;
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
