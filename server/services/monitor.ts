import fs from 'node:fs';
import { q } from '../lib/db.ts';
import { bus } from '../lib/events.ts';
import { tryRun } from '../lib/exec.ts';
import { DATA, UNIT } from '../lib/paths.ts';
import { settings } from '../lib/settings.ts';
import type { AppRow, DbRow } from '../lib/types.ts';
import { getApp } from './apps.ts';
import * as journal from './journal.ts';
import { notify } from './notify.ts';
import * as systemd from './systemd.ts';

export type RunState = 'running' | 'starting' | 'restarting' | 'stopping' | 'stopped' | 'failed' | 'not-deployed' | 'unknown';

export interface UnitStatus {
  unit: string;
  state: RunState;
  activeState: string;
  subState: string;
  pid: number;
  restarts: number;
  memory: number | null;
  /** 코어 1개 = 100 */
  cpu: number | null;
  tasks: number | null;
  since: number | null;
  enabled: boolean;
  exitStatus: number | null;
  result: string;
  listen: { addr: string; port: number }[];
}

export interface SysSample {
  t: number;
  cpu: number;
  mem: number;
  memUsed: number;
  rx: number;
  tx: number;
  load: number;
}

const PROPS = [
  'ActiveState',
  'SubState',
  'MainPID',
  'NRestarts',
  'MemoryCurrent',
  'CPUUsageNSec',
  'TasksCurrent',
  'ActiveEnterTimestampMonotonic',
  'UnitFileState',
  'ExecMainStatus',
  'Result',
  'LoadState',
];

const statuses = new Map<string, UnitStatus>();
const prevCpu = new Map<string, { ns: number; t: number }>();
const unitHistory = new Map<string, { t: number; cpu: number; mem: number }[]>();
const sysHistory: SysSample[] = [];
const sysHistoryLong: SysSample[] = [];
let lastSys: (SysSample & { memTotal: number; swapTotal: number; swapUsed: number; cores: number[]; disk: DiskInfo[]; uptime: number }) | null = null;
let listenMap = new Map<string, { addr: string; port: number }[]>();

export interface DiskInfo {
  mount: string;
  total: number;
  used: number;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === '' || v === '[not set]') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n >= 2 ** 63 - 2 ** 12) return null; // UINT64_MAX = 미지원
  return n;
}

/** systemd 의 *Monotonic 값(µs)을 실제 시각(ms)으로. LXC 에서는 /proc/uptime 이 호스트 monotonic 과 달라서 hrtime 을 쓴다 */
function monoToRealMs(monoUs: number) {
  const nowMonoUs = Number(process.hrtime.bigint() / 1000n);
  return Math.round(Date.now() - (nowMonoUs - monoUs) / 1000);
}

function deriveState(p: systemd.UnitProps): RunState {
  if (p.LoadState === 'not-found') return 'not-deployed';
  switch (p.ActiveState) {
    case 'active':
    case 'reloading':
      return 'running';
    case 'activating':
      return p.SubState === 'auto-restart' ? 'restarting' : 'starting';
    case 'deactivating':
      return 'stopping';
    case 'failed':
      return 'failed';
    case 'inactive':
      return 'stopped';
    default:
      return 'unknown';
  }
}

export function getStatus(unit: string): UnitStatus | null {
  return statuses.get(unit) ?? null;
}

export function allStatuses() {
  return Object.fromEntries(statuses);
}

export function unitHistoryOf(unit: string) {
  return unitHistory.get(unit) ?? [];
}

// ---------- 유닛 상태 ----------

const crashNotified = new Map<string, number>();

async function pollUnits() {
  const apps = q.all<Pick<AppRow, 'slug' | 'desired_state' | 'name'>>('SELECT slug, desired_state, name FROM apps');
  const dbs = q.all<Pick<DbRow, 'slug' | 'desired_state' | 'name' | 'initialized'>>('SELECT slug, desired_state, name, initialized FROM databases');
  const units = [
    UNIT.panel,
    UNIT.rootSlice,
    UNIT.appsSlice,
    UNIT.dbsSlice,
    ...apps.map((a) => UNIT.app(a.slug)),
    ...dbs.map((d) => UNIT.db(d.slug)),
  ];
  const props = await systemd.show(units, PROPS);
  const t = Date.now();
  const seen = new Set<string>();
  for (const [unit, p] of props) {
    seen.add(unit);
    const ns = num(p.CPUUsageNSec);
    let cpu: number | null = null;
    const prev = prevCpu.get(unit);
    if (ns !== null) {
      if (prev && t > prev.t && ns >= prev.ns) cpu = ((ns - prev.ns) / 1e6 / (t - prev.t)) * 100;
      prevCpu.set(unit, { ns, t });
    }
    const mono = num(p.ActiveEnterTimestampMonotonic);
    const st: UnitStatus = {
      unit,
      state: deriveState(p),
      activeState: p.ActiveState ?? '',
      subState: p.SubState ?? '',
      pid: Number(p.MainPID ?? 0),
      restarts: Number(p.NRestarts ?? 0),
      memory: num(p.MemoryCurrent),
      cpu: cpu === null ? null : Math.round(cpu * 10) / 10,
      tasks: num(p.TasksCurrent),
      since: mono && mono > 0 ? monoToRealMs(mono) : null,
      enabled: p.UnitFileState === 'enabled',
      exitStatus: num(p.ExecMainStatus),
      result: p.Result ?? '',
      listen: listenMap.get(unit) ?? [],
    };
    const old = statuses.get(unit);
    statuses.set(unit, st);
    if (st.state === 'running') {
      const h = unitHistory.get(unit) ?? [];
      h.push({ t, cpu: st.cpu ?? 0, mem: st.memory ?? 0 });
      if (h.length > 300) h.splice(0, h.length - 300);
      unitHistory.set(unit, h);
    }
    const app = apps.find((a) => UNIT.app(a.slug) === unit);
    if (app && old) await detectCrash(app, old, st);
    const db = dbs.find((d) => UNIT.db(d.slug) === unit);
    if (db && old && db.desired_state === 'running' && db.initialized) await detectDbCrash(db, old, st);
  }
  for (const k of [...statuses.keys()]) if (!seen.has(k)) statuses.delete(k);
}

async function detectCrash(app: Pick<AppRow, 'slug' | 'desired_state' | 'name'>, old: UnitStatus, st: UnitStatus) {
  if (app.desired_state !== 'running') return;
  const crashed = st.restarts > old.restarts || (st.state === 'failed' && old.state !== 'failed') || (st.state === 'stopped' && old.state === 'running');
  if (!crashed) return;
  const unit = UNIT.app(app.slug);
  const lastAt = crashNotified.get(unit) ?? 0;
  const gaveUp = st.state === 'failed';
  const exit = await lastExitReason(unit);
  await journal.mark(
    unit,
    gaveUp ? `⚠ 프로세스가 반복해서 죽어 재시작을 멈췄습니다 (${exit})` : st.state === 'stopped' ? `프로세스가 종료됨 (${exit})` : `⚠ 프로세스 종료 (${exit}) → 자동 재시작`,
    3,
  );
  if (Date.now() - lastAt < 10 * 60_000 && !gaveUp) return;
  crashNotified.set(unit, Date.now());
  const full = getApp(app.slug);
  const logs = (await journal.recent(unit, 15)).map((e) => e.m).join('\n');
  await notify({
    kind: 'crash',
    app: full,
    title: gaveUp ? `🛑 ${app.name}: 반복 크래시로 중지됨` : `💥 ${app.name}: 프로세스 크래시`,
    description: `${exit}, 재시작 ${st.restarts}회\n\`\`\`\n${logs.slice(-1500)}\n\`\`\``,
    color: 'red',
    path: `/apps/${app.slug}?tab=console`,
  });
}

/** systemd 가 남긴 "Main process exited, code=..., status=..." 에서 종료 원인 */
async function lastExitReason(unit: string) {
  const entries = await journal.recent(unit, 40);
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]!.m.match(/Main process exited, code=(\w+), status=(\d+)\/?(\w*)/);
    if (!m) continue;
    if (m[1] === 'killed' || m[1] === 'dumped') return `시그널 ${m[3] || m[2]}${m[1] === 'dumped' ? ' (core dump)' : ''}`;
    return `종료 코드 ${m[2]}`;
  }
  return '종료 원인 알 수 없음';
}

async function detectDbCrash(db: Pick<DbRow, 'slug' | 'name'>, old: UnitStatus, st: UnitStatus) {
  const crashed = st.restarts > old.restarts || (st.state === 'failed' && old.state !== 'failed');
  if (!crashed) return;
  const unit = UNIT.db(db.slug);
  const lastAt = crashNotified.get(unit) ?? 0;
  if (Date.now() - lastAt < 10 * 60_000) return;
  crashNotified.set(unit, Date.now());
  await notify({
    kind: 'alert',
    title: `💥 DB ${db.name} 비정상 종료`,
    description: `상태: ${st.activeState}/${st.subState}, 재시작 ${st.restarts}회`,
    color: 'red',
    path: `/databases/${db.slug}`,
  });
}

// ---------- 리스닝 포트 ----------

async function pollListen() {
  const r = await tryRun('ss', ['-Htlnp']);
  const pidUnit = new Map<number, string | null>();
  const unitOfPid = (pid: number) => {
    if (pidUnit.has(pid)) return pidUnit.get(pid)!;
    let u: string | null = null;
    try {
      const cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
      u = cg.match(/\/(hrone-(?:app|db)-[a-z0-9-]+\.service)/)?.[1] ?? (cg.includes('/hrone.service') ? UNIT.panel : null);
    } catch {
      /* 종료됨 */
    }
    pidUnit.set(pid, u);
    return u;
  };
  const map = new Map<string, { addr: string; port: number }[]>();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+(.*)$/);
    if (!m) continue;
    const addr = m[1]!.replace(/^\[|\]$/g, '');
    const port = Number(m[2]);
    const pids = [...m[3]!.matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
    for (const pid of new Set(pids)) {
      const u = unitOfPid(pid);
      if (!u) continue;
      const list = map.get(u) ?? [];
      if (!list.some((x) => x.addr === addr && x.port === port)) list.push({ addr, port });
      map.set(u, list);
    }
  }
  listenMap = map;
}

// ---------- 시스템 ----------

let prevStat: { total: number; idle: number; cores: { total: number; idle: number }[] } | null = null;
let prevNet: { rx: number; tx: number; t: number } | null = null;

function readStat() {
  const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
  const parse = (l: string) => {
    const v = l.trim().split(/\s+/).slice(1).map(Number);
    const idle = (v[3] ?? 0) + (v[4] ?? 0);
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
    return { total, idle };
  };
  const all = parse(lines[0]!);
  const cores = lines.filter((l) => /^cpu\d+\s/.test(l)).map(parse);
  return { ...all, cores };
}

function readMem() {
  const m: Record<string, number> = {};
  for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const x = l.match(/^(\w+):\s+(\d+)/);
    if (x) m[x[1]!] = Number(x[2]) * 1024;
  }
  return m;
}

function readNet() {
  let rx = 0;
  let tx = 0;
  for (const l of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
    const [iface, rest] = l.split(':');
    if (!rest || !iface || iface.trim() === 'lo') continue;
    const v = rest.trim().split(/\s+/).map(Number);
    rx += v[0] ?? 0;
    tx += v[8] ?? 0;
  }
  return { rx, tx };
}

function disks(): DiskInfo[] {
  const out: DiskInfo[] = [];
  const seen = new Set<string>();
  for (const mount of ['/', DATA]) {
    try {
      const s = fs.statfsSync(mount);
      const key = `${s.blocks}-${s.bfree}-${s.bsize}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ mount, total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize });
    } catch {
      /* noop */
    }
  }
  return out;
}

function pollSystem() {
  const t = Date.now();
  const stat = readStat();
  let cpu = 0;
  let cores: number[] = [];
  if (prevStat) {
    const dt = stat.total - prevStat.total;
    cpu = dt > 0 ? (1 - (stat.idle - prevStat.idle) / dt) * 100 : 0;
    cores = stat.cores.map((c, i) => {
      const p = prevStat!.cores[i];
      if (!p) return 0;
      const d = c.total - p.total;
      return d > 0 ? Math.round((1 - (c.idle - p.idle) / d) * 1000) / 10 : 0;
    });
  }
  prevStat = stat;
  const m = readMem();
  const memTotal = m.MemTotal ?? 0;
  const memUsed = memTotal - (m.MemAvailable ?? m.MemFree ?? 0);
  const net = readNet();
  let rx = 0;
  let tx = 0;
  if (prevNet && t > prevNet.t) {
    rx = Math.max(0, ((net.rx - prevNet.rx) * 1000) / (t - prevNet.t));
    tx = Math.max(0, ((net.tx - prevNet.tx) * 1000) / (t - prevNet.t));
  }
  prevNet = { ...net, t };
  const load = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  const sample: SysSample = {
    t,
    cpu: Math.round(Math.max(0, Math.min(100, cpu)) * 10) / 10,
    mem: memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : 0,
    memUsed,
    rx: Math.round(rx),
    tx: Math.round(tx),
    load,
  };
  lastSys = {
    ...sample,
    memTotal,
    swapTotal: m.SwapTotal ?? 0,
    swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
    cores,
    disk: disks(),
    uptime: Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]),
  };
  sysHistory.push(sample);
  if (sysHistory.length > 1800) sysHistory.splice(0, sysHistory.length - 1800);
  const last = sysHistoryLong[sysHistoryLong.length - 1];
  if (!last || t - last.t >= 60_000) {
    // 1분 평균
    const win = sysHistory.filter((s) => s.t > t - 60_000);
    const avg = (k: keyof SysSample) => win.reduce((a, s) => a + (s[k] as number), 0) / Math.max(1, win.length);
    sysHistoryLong.push({ t, cpu: avg('cpu'), mem: avg('mem'), memUsed: avg('memUsed'), rx: avg('rx'), tx: avg('tx'), load: avg('load') });
    if (sysHistoryLong.length > 1440) sysHistoryLong.splice(0, sysHistoryLong.length - 1440);
  }
}

export function systemNow() {
  return lastSys;
}

export function systemHistory(range: '1h' | '24h') {
  return range === '24h' ? sysHistoryLong : sysHistory;
}

// ---------- 경고 ----------

const alertAt = new Map<string, number>();
let memHighSince = 0;

async function checkAlerts() {
  const a = settings.alerts();
  if (!a.enabled || !lastSys) return;
  for (const d of lastSys.disk) {
    const pct = (d.used / d.total) * 100;
    const key = `disk:${d.mount}`;
    if (pct >= a.diskPercent && Date.now() - (alertAt.get(key) ?? 0) > 6 * 3600_000) {
      alertAt.set(key, Date.now());
      await notify({ kind: 'alert', title: `💾 디스크 ${pct.toFixed(0)}% 사용 중 (${d.mount})`, description: `경고 기준 ${a.diskPercent}%`, color: 'yellow', path: '/system' });
    }
  }
  if (lastSys.mem >= a.memPercent) {
    if (!memHighSince) memHighSince = Date.now();
    if (Date.now() - memHighSince > 3 * 60_000 && Date.now() - (alertAt.get('mem') ?? 0) > 3600_000) {
      alertAt.set('mem', Date.now());
      await notify({ kind: 'alert', title: `🧠 메모리 ${lastSys.mem.toFixed(0)}% 사용 중`, description: `3분 이상 경고 기준(${a.memPercent}%) 초과`, color: 'yellow', path: '/system' });
    }
  } else memHighSince = 0;
}

// ---------- 루프 ----------

let tick = 0;

export function startMonitor() {
  const loop = async () => {
    try {
      if (tick % 5 === 0) await pollListen();
      await pollUnits();
      pollSystem();
      if (tick % 30 === 0) await checkAlerts();
      bus.publish('status', { units: allStatuses(), system: lastSys });
    } catch {
      /* 다음 틱에 다시 */
    }
    tick++;
    setTimeout(loop, 2000).unref();
  };
  void loop();
}
