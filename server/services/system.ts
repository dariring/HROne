import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, tryRun, which } from '../lib/exec.ts';
import { ROOT, UNIT } from '../lib/paths.ts';
import { writeFileIfChanged } from '../lib/util.ts';
import { mariadbBins, redisBins } from './packages.ts';
import { installedNodeVersions, installedPythons, uvPath } from './runtimes.ts';

let virtCache: string | null = null;

export async function virtualization() {
  if (virtCache) return virtCache;
  const r = await tryRun('systemd-detect-virt');
  virtCache = r.stdout.trim() || 'none';
  return virtCache;
}

export async function isContainer() {
  const r = await tryRun('systemd-detect-virt', ['--container']);
  return r.code === 0 && r.stdout.trim() !== 'none';
}

function osRelease() {
  try {
    const t = fs.readFileSync('/etc/os-release', 'utf8');
    return t.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? 'Linux';
  } catch {
    return 'Linux';
  }
}

async function serviceState(unit: string) {
  const r = await tryRun('systemctl', ['is-active', unit]);
  return r.stdout.trim() || 'unknown';
}

export async function tailscaleInfo() {
  const bin = await which('tailscale');
  if (!bin) return { installed: false as const };
  const ip4 = (await tryRun(bin, ['ip', '-4'], { timeoutMs: 5000 })).stdout.trim().split('\n')[0] || null;
  const st = await tryRun(bin, ['status', '--json'], { timeoutMs: 5000 });
  let dnsName: string | null = null;
  let backend: string | null = null;
  try {
    const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    backend = j.BackendState ?? null;
    dnsName = j.Self?.DNSName?.replace(/\.$/, '') ?? null;
  } catch {
    /* noop */
  }
  return { installed: true as const, ip: ip4, dnsName, state: backend, service: await serviceState('tailscaled') };
}

export async function cloudflaredInfo() {
  const bin = await which('cloudflared');
  if (!bin) return { installed: false as const };
  const v = (await tryRun(bin, ['--version'], { timeoutMs: 5000 })).stdout.trim();
  // 로컬 설정 파일이 있으면 ingress 목록을 보여준다
  let ingress: { hostname: string; service: string }[] = [];
  for (const f of ['/etc/cloudflared/config.yml', '/etc/cloudflared/config.yaml', '/root/.cloudflared/config.yml']) {
    try {
      const t = fs.readFileSync(f, 'utf8');
      const items = [...t.matchAll(/-\s*hostname:\s*(\S+)\s*\n\s*service:\s*(\S+)/g)].map((m) => ({ hostname: m[1]!, service: m[2]! }));
      if (items.length) {
        ingress = items;
        break;
      }
    } catch {
      /* 없음 */
    }
  }
  return { installed: true as const, version: v.split('\n')[0], service: await serviceState('cloudflared'), ingress };
}

export async function info() {
  const cpus = os.cpus();
  const nets = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address })))
    .filter((n) => !n.name.startsWith('docker') && !n.name.startsWith('veth'));
  const tz = (await tryRun('timedatectl', ['show', '-p', 'Timezone', '--value'])).stdout.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    hostname: os.hostname(),
    os: osRelease(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? '',
    cores: cpus.length,
    memTotal: os.totalmem(),
    virtualization: await virtualization(),
    container: await isContainer(),
    timezone: tz,
    uptime: os.uptime(),
    networks: nets,
    panelNode: process.version,
    panelVersion: panelVersion(),
    tailscale: await tailscaleInfo(),
    cloudflared: await cloudflaredInfo(),
    cgroupControllers: (() => {
      try {
        return fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8').trim().split(/\s+/);
      } catch {
        return [];
      }
    })(),
  };
}

export function panelVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '?';
  }
}

export async function components() {
  const maria = await mariadbBins();
  const rd = await redisBins();
  return {
    node: installedNodeVersions(),
    python: await installedPythons(),
    uv: uvPath() ? (await tryRun(uvPath()!, ['--version'])).stdout.trim() : null,
    mariadb: maria ? maria.version : null,
    redis: rd ? `${rd.flavor} ${rd.version}` : null,
    git: (await tryRun('git', ['--version'])).stdout.trim().replace('git version ', '') || null,
    buildEssential: !!(await which('gcc')),
  };
}

// ---------- 커널 튜닝 ----------

export const TUNING: { key: string; value: string; why: string }[] = [
  { key: 'net.core.somaxconn', value: '65535', why: '대기 연결 큐 (동시 접속 많을 때)' },
  { key: 'net.ipv4.tcp_max_syn_backlog', value: '65535', why: 'SYN 대기 큐' },
  { key: 'net.ipv4.ip_local_port_range', value: '1024 65535', why: '아웃바운드 연결용 포트 범위' },
  { key: 'net.ipv4.tcp_tw_reuse', value: '1', why: 'TIME_WAIT 소켓 재사용' },
  { key: 'fs.file-max', value: '2097152', why: '시스템 전체 파일 핸들 상한' },
  { key: 'fs.inotify.max_user_watches', value: '524288', why: '파일 감시 (개발 서버/번들러)' },
  { key: 'vm.overcommit_memory', value: '1', why: 'Redis 권장 (백그라운드 저장 실패 방지)' },
  { key: 'vm.swappiness', value: '10', why: '스왑 사용 최소화' },
];

const SYSCTL_FILE = '/etc/sysctl.d/90-hrone.conf';

export async function tuningStatus() {
  const out = [];
  for (const t of TUNING) {
    const r = await tryRun('sysctl', ['-n', t.key]);
    out.push({ ...t, current: r.code === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : null });
  }
  return out;
}

/** 적용 가능한 항목만 적용 (LXC 에서는 일부 키가 읽기 전용) */
export async function applyTuning(keys: string[]) {
  const results: { key: string; ok: boolean; error?: string }[] = [];
  const applied: string[] = [];
  for (const t of TUNING.filter((x) => keys.includes(x.key))) {
    const r = await tryRun('sysctl', ['-w', `${t.key}=${t.value}`]);
    if (r.code === 0) {
      applied.push(`${t.key} = ${t.value}`);
      results.push({ key: t.key, ok: true });
    } else results.push({ key: t.key, ok: false, error: (r.stderr || r.stdout).trim() || '적용 실패 (컨테이너에서는 호스트가 관리할 수 있습니다)' });
  }
  let existing: string[] = [];
  try {
    existing = fs.readFileSync(SYSCTL_FILE, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  } catch {
    /* 없음 */
  }
  const merged = new Map(existing.map((l) => [l.split('=')[0]!.trim(), l]));
  for (const a of applied) merged.set(a.split('=')[0]!.trim(), a);
  writeFileIfChanged(SYSCTL_FILE, `# HROne 커널 튜닝\n${[...merged.values()].join('\n')}\n`);
  return results;
}

// ---------- 스왑 ----------

const SWAPFILE = '/swapfile-hrone';

export async function swapStatus() {
  const r = await tryRun('swapon', ['--show=NAME,SIZE,USED,TYPE', '--noheadings', '--bytes']);
  const list = r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, size, used, type] = l.trim().split(/\s+/);
      return { name: name!, size: Number(size), used: Number(used), type: type! };
    });
  return { list, managed: fs.existsSync(SWAPFILE), container: await isContainer() };
}

export async function createSwap(sizeMB: number) {
  if (await isContainer()) throw new Error('LXC/컨테이너 안에서는 스왑을 만들 수 없습니다. 호스트(Proxmox)에서 컨테이너 스왑을 설정하세요.');
  if (fs.existsSync(SWAPFILE)) await removeSwap();
  await run('fallocate', ['-l', `${sizeMB}M`, SWAPFILE]).catch(() => run('dd', ['if=/dev/zero', `of=${SWAPFILE}`, 'bs=1M', `count=${sizeMB}`]));
  fs.chmodSync(SWAPFILE, 0o600);
  await run('mkswap', [SWAPFILE]);
  await run('swapon', [SWAPFILE]);
  const fstab = fs.readFileSync('/etc/fstab', 'utf8');
  if (!fstab.includes(SWAPFILE)) fs.appendFileSync('/etc/fstab', `${SWAPFILE} none swap sw 0 0\n`);
}

export async function removeSwap() {
  await tryRun('swapoff', [SWAPFILE]);
  fs.rmSync(SWAPFILE, { force: true });
  const fstab = fs.readFileSync('/etc/fstab', 'utf8');
  fs.writeFileSync('/etc/fstab', fstab.split('\n').filter((l) => !l.includes(SWAPFILE)).join('\n'));
}

// ---------- 시간대 ----------

export async function timezones() {
  const r = await tryRun('timedatectl', ['list-timezones']);
  return r.stdout.split('\n').filter(Boolean);
}

export async function setTimezone(tz: string) {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) throw new Error('잘못된 시간대');
  const r = await tryRun('timedatectl', ['set-timezone', tz]);
  if (r.code !== 0) {
    // 컨테이너 등 timedatectl 불가 환경
    const zone = `/usr/share/zoneinfo/${tz}`;
    if (!fs.existsSync(zone)) throw new Error('시간대를 찾을 수 없습니다');
    fs.rmSync('/etc/localtime', { force: true });
    fs.symlinkSync(zone, '/etc/localtime');
    fs.writeFileSync('/etc/timezone', tz + '\n');
  }
}

// ---------- 패널 업데이트 ----------

export async function updateCheck() {
  const env = { GIT_TERMINAL_PROMPT: '0', HOME: '/root' };
  const cwd = ROOT;
  if (!fs.existsSync(path.join(ROOT, '.git'))) return { available: false, error: 'git 저장소가 아닙니다 (개발 모드?)' };
  const branch = (await tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, env })).stdout.trim() || 'main';
  const fetch = await tryRun('git', ['fetch', '--quiet', 'origin', branch], { cwd, env, timeoutMs: 60_000 });
  if (fetch.code !== 0) return { available: false, error: fetch.stderr.trim() };
  const local = (await tryRun('git', ['rev-parse', 'HEAD'], { cwd, env })).stdout.trim();
  const remote = (await tryRun('git', ['rev-parse', `origin/${branch}`], { cwd, env })).stdout.trim();
  const log = (await tryRun('git', ['log', '--format=%h%x1f%s%x1f%ar', `HEAD..origin/${branch}`, '-n', '30'], { cwd, env })).stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, msg, when] = l.split('\x1f');
      return { sha: sha!, message: msg!, when: when! };
    });
  return { available: local !== remote && log.length > 0, local, remote, branch, commits: log };
}

/** 패널 자신은 업데이트 중 재시작되므로 별도 유닛으로 실행 */
export async function runUpdate() {
  await tryRun('systemctl', ['reset-failed', 'hrone-update.service']);
  await run('systemd-run', [
    '--unit=hrone-update',
    '--collect',
    '--description=HROne 패널 업데이트',
    '/bin/bash',
    path.join(ROOT, 'scripts', 'update.sh'),
  ]);
}

export async function updateLog() {
  const r = await tryRun('journalctl', ['--no-pager', '-o', 'cat', '-n', '300', '-u', 'hrone-update.service']);
  // eslint-disable-next-line no-control-regex
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

export async function restartPanel() {
  await run('systemd-run', ['--on-active=1', '--collect', 'systemctl', 'restart', UNIT.panel]);
}
