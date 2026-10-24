import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { run, tryRun } from '../lib/exec.ts';
import { PATHS, UNIT } from '../lib/paths.ts';
import type { Limits, Resources } from '../lib/types.ts';
import { writeFileIfChanged } from '../lib/util.ts';

export async function systemctl(...args: string[]) {
  return run('systemctl', args, { timeoutMs: 120_000 });
}

export async function daemonReload() {
  await systemctl('daemon-reload');
}

export function unitPath(unit: string) {
  return path.join(PATHS.unitDir, unit);
}

/** 유닛 파일을 쓰고 바뀌었으면 true (daemon-reload 필요) */
export function writeUnit(unit: string, content: string) {
  return writeFileIfChanged(unitPath(unit), content, 0o644);
}

export async function removeUnit(unit: string) {
  await tryRun('systemctl', ['disable', '--now', unit]);
  try {
    fs.rmSync(unitPath(unit), { force: true });
    fs.rmSync(unitPath(unit) + '.d', { recursive: true, force: true });
  } catch {
    /* noop */
  }
  await tryRun('systemctl', ['reset-failed', unit]);
  await daemonReload();
}

export async function isEnabled(unit: string) {
  const r = await tryRun('systemctl', ['is-enabled', unit]);
  return r.stdout.trim() === 'enabled';
}

export async function setEnabled(unit: string, enabled: boolean) {
  await systemctl(enabled ? 'enable' : 'disable', unit);
}

export type UnitProps = Record<string, string>;

/** 여러 유닛의 속성을 한 번에 읽는다 */
export async function show(units: string[], props: string[]): Promise<Map<string, UnitProps>> {
  const out = new Map<string, UnitProps>();
  if (!units.length) return out;
  const r = await tryRun('systemctl', ['show', '--no-pager', `--property=Id,${props.join(',')}`, ...units]);
  for (const block of r.stdout.split(/\n\s*\n/)) {
    const p: UnitProps = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) p[line.slice(0, i)] = line.slice(i + 1);
    }
    if (p.Id) out.set(p.Id, p);
  }
  return out;
}

let accounting: string[] | null = null;

/**
 * 유닛에 넣을 *Accounting= 지시어. systemd 258 부터 cgroup v1 지원이 빠지면서 CPU 사용량은 항상 집계되고
 * CPUAccounting= 은 없어진 옵션이라 유닛을 읽을 때마다 경고가 남는다 (Ubuntu 26.04 = systemd 259).
 */
export function accountingDirectives(extra: string[] = []): string[] {
  if (!accounting) {
    let version = 0;
    try {
      version = Number(/systemd (\d+)/.exec(execFileSync('systemctl', ['--version'], { encoding: 'utf8', timeout: 10_000 }))?.[1] ?? 0);
    } catch {
      /* 알 수 없으면 예전처럼 쓴다 */
    }
    accounting = version >= 258 ? [] : ['CPUAccounting=yes'];
  }
  return [...accounting, 'MemoryAccounting=yes', ...extra];
}

/** 리소스 제한을 systemd 지시어로 */
export function resourceDirectives(r: Resources | undefined): string[] {
  if (!r) return [];
  const lines: string[] = [];
  if (r.cpu && r.cpu > 0) lines.push(`CPUQuota=${Math.round(r.cpu * 100)}%`);
  if (r.cpuWeight && r.cpuWeight > 0) lines.push(`CPUWeight=${Math.round(r.cpuWeight)}`);
  if (r.memoryMB && r.memoryMB > 0) {
    lines.push(`MemoryMax=${Math.round(r.memoryMB)}M`);
    // 상한의 90% 부터 회수 압박 → 갑작스런 OOM kill 대신 느려지는 쪽으로
    lines.push(`MemoryHigh=${Math.round(r.memoryMB * 0.9)}M`);
  }
  if (r.swapMB !== null && r.swapMB !== undefined && r.swapMB >= 0) lines.push(`MemorySwapMax=${Math.round(r.swapMB)}M`);
  if (r.tasks && r.tasks > 0) lines.push(`TasksMax=${Math.round(r.tasks)}`);
  return lines;
}

/** 실행 중 유닛에 즉시 적용 (재시작 없이). --runtime 이라 재부팅 시엔 유닛 파일 값이 쓰인다. */
export async function applyResourcesLive(unit: string, r: Resources) {
  const props = [
    `CPUQuota=${r.cpu && r.cpu > 0 ? `${Math.round(r.cpu * 100)}%` : ''}`,
    `CPUWeight=${r.cpuWeight && r.cpuWeight > 0 ? Math.round(r.cpuWeight) : ''}`,
    `MemoryMax=${r.memoryMB && r.memoryMB > 0 ? `${Math.round(r.memoryMB)}M` : 'infinity'}`,
    `MemoryHigh=${r.memoryMB && r.memoryMB > 0 ? `${Math.round(r.memoryMB * 0.9)}M` : 'infinity'}`,
    `MemorySwapMax=${r.swapMB !== null && r.swapMB !== undefined && r.swapMB >= 0 ? `${Math.round(r.swapMB)}M` : 'infinity'}`,
    `TasksMax=${r.tasks && r.tasks > 0 ? Math.round(r.tasks) : 'infinity'}`,
  ];
  return tryRun('systemctl', ['set-property', '--runtime', unit, ...props]);
}

function sliceUnit(desc: string, r: Resources) {
  return [
    '[Unit]',
    `Description=${desc}`,
    'Before=slices.target',
    '',
    '[Slice]',
    ...accountingDirectives(['TasksAccounting=yes', 'IOAccounting=yes']),
    ...resourceDirectives(r),
    '',
  ].join('\n');
}

/** hrone.slice (전체) > hrone-apps.slice / hrone-dbs.slice */
export async function writeSlices(limits: Limits, live = true) {
  let changed = false;
  changed = writeUnit(UNIT.rootSlice, sliceUnit('HROne (전체 상한)', limits.total)) || changed;
  changed = writeUnit(UNIT.appsSlice, sliceUnit('HROne 앱', limits.apps)) || changed;
  changed = writeUnit(UNIT.dbsSlice, sliceUnit('HROne 데이터베이스', limits.dbs)) || changed;
  if (changed) await daemonReload();
  if (live) {
    await applyResourcesLive(UNIT.rootSlice, limits.total);
    await applyResourcesLive(UNIT.appsSlice, limits.apps);
    await applyResourcesLive(UNIT.dbsSlice, limits.dbs);
  }
  return changed;
}

/** systemd EnvironmentFile 용 값 인용 */
export function envFileLine(key: string, value: string) {
  const v = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
  return `${key}="${v}"`;
}

/**
 * ExecStart 용: /bin/bash -c "<cmd>". systemd 가 % 와 $ 를 해석하므로 이스케이프한다.
 * 단순 명령이면 bash 가 알아서 exec 하므로 시그널도 앱에 바로 간다.
 */
export function execShell(cmd: string) {
  const escaped = cmd.replace(/%/g, '%%').replace(/\$/g, '$$$$').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `/bin/bash -c "${escaped}"`;
}
