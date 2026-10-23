import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, tryRun, which } from '../lib/exec.ts';
import { log } from '../lib/log.ts';
import { PATHS } from '../lib/paths.ts';
import { KeyedMutex, rmrf } from '../lib/util.ts';

const mutex = new KeyedMutex();
type Logger = (line: string) => void;

export function nodeArch() {
  const a = os.arch();
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'arm64';
  throw new Error(`지원하지 않는 CPU 아키텍처: ${a}`);
}

interface NodeIndexEntry {
  version: string;
  lts: string | false;
  date: string;
}

let indexCache: { at: number; list: NodeIndexEntry[] } | null = null;

export async function nodeIndex(): Promise<NodeIndexEntry[]> {
  if (indexCache && Date.now() - indexCache.at < 3600_000) return indexCache.list;
  const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`nodejs.org 응답 오류 ${res.status}`);
  const list = (await res.json()) as NodeIndexEntry[];
  indexCache = { at: Date.now(), list };
  return list;
}

export function installedNodeVersions(): string[] {
  try {
    return fs
      .readdirSync(PATHS.nodeRuntimes)
      .filter((d) => /^v\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(PATHS.nodeRuntimes, d, 'bin', 'node')))
      .sort((a, b) => cmpVer(b, a));
  } catch {
    return [];
  }
}

function cmpVer(a: string, b: string) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** '24' / '22.11' / 'v24.1.0' / 'lts' → 설치된 버전 중 맞는 것 (없으면 null) */
export function matchInstalledNode(spec: string): string | null {
  const s = spec.replace(/^v/, '').trim();
  const installed = installedNodeVersions();
  if (s === 'lts' || s === '') return installed[0] ?? null;
  return installed.find((v) => v.slice(1) === s || v.slice(1).startsWith(s + '.')) ?? null;
}

async function resolveNodeSpec(spec: string): Promise<string> {
  const s = spec.replace(/^v/, '').trim();
  const list = await nodeIndex();
  const found =
    s === 'lts' || s === ''
      ? list.find((e) => e.lts)
      : list.find((e) => e.version.slice(1) === s || e.version.slice(1).startsWith(s + '.'));
  if (!found) throw new Error(`Node.js 버전을 찾을 수 없습니다: ${spec}`);
  return found.version;
}

/** 해당 버전의 Node 가 없으면 내려받아 설치하고 bin 디렉터리를 돌려준다 */
export function ensureNode(spec: string, onLog: Logger = () => {}): Promise<string> {
  return mutex.run('node', async () => {
    const have = matchInstalledNode(spec);
    if (have) return path.join(PATHS.nodeRuntimes, have, 'bin');
    const version = await resolveNodeSpec(spec);
    const arch = nodeArch();
    const name = `node-${version}-linux-${arch}`;
    const base = `https://nodejs.org/dist/${version}`;
    onLog(`Node.js ${version} (${arch}) 내려받는 중...`);
    const sums = await (await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) })).text();
    const expected = sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.xz`))?.split(' ')[0];
    if (!expected) throw new Error('SHASUMS256 에서 체크섬을 찾지 못했습니다');
    fs.mkdirSync(PATHS.tmp, { recursive: true });
    const tarball = path.join(PATHS.tmp, `${name}.tar.xz`);
    const res = await fetch(`${base}/${name}.tar.xz`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`다운로드 실패 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual !== expected) throw new Error('체크섬 불일치 — 다운로드가 손상되었습니다');
    fs.writeFileSync(tarball, buf);
    const dest = path.join(PATHS.nodeRuntimes, version);
    const staging = `${dest}.partial`;
    rmrf(staging);
    fs.mkdirSync(staging, { recursive: true });
    await run('tar', ['-xJf', tarball, '-C', staging, '--strip-components=1', '--no-same-owner']);
    fs.rmSync(tarball, { force: true });
    rmrf(dest);
    fs.renameSync(staging, dest);
    await run('chmod', ['-R', 'a+rX', dest]);
    onLog(`Node.js ${version} 설치 완료`);
    log.info(`node ${version} installed`);
    return path.join(dest, 'bin');
  });
}

export function removeNode(version: string) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('잘못된 버전');
  if (process.execPath.startsWith(path.join(PATHS.nodeRuntimes, version) + path.sep)) {
    throw new Error('패널이 사용 중인 버전은 지울 수 없습니다');
  }
  rmrf(path.join(PATHS.nodeRuntimes, version));
}

// ---------- Python (uv) ----------

export function uvPath() {
  const p = path.join(PATHS.bin, 'uv');
  return fs.existsSync(p) ? p : null;
}

export function uvTarget() {
  return os.arch() === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}

export function ensureUv(onLog: Logger = () => {}): Promise<string> {
  return mutex.run('uv', async () => {
    const have = uvPath();
    if (have) return have;
    const target = uvTarget();
    const url = `https://github.com/astral-sh/uv/releases/latest/download/uv-${target}.tar.gz`;
    onLog('uv (Python 패키지 관리자) 내려받는 중...');
    const [tarRes, sumRes] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(5 * 60_000) }),
      fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!tarRes.ok) throw new Error(`uv 다운로드 실패 ${tarRes.status}`);
    const buf = Buffer.from(await tarRes.arrayBuffer());
    if (sumRes.ok) {
      const expected = (await sumRes.text()).trim().split(/\s+/)[0];
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (expected && expected !== actual) throw new Error('uv 체크섬 불일치');
    }
    fs.mkdirSync(PATHS.tmp, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(PATHS.tmp, 'uv-'));
    const tarball = path.join(tmpDir, 'uv.tar.gz');
    fs.writeFileSync(tarball, buf);
    await run('tar', ['-xzf', tarball, '-C', tmpDir, '--strip-components=1', '--no-same-owner']);
    fs.mkdirSync(PATHS.bin, { recursive: true });
    for (const b of ['uv', 'uvx']) {
      const src = path.join(tmpDir, b);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(PATHS.bin, b));
        fs.chmodSync(path.join(PATHS.bin, b), 0o755);
      }
    }
    rmrf(tmpDir);
    onLog('uv 설치 완료');
    return path.join(PATHS.bin, 'uv');
  });
}

export async function systemPython(): Promise<string | null> {
  return (await which('python3')) ?? null;
}

export async function pythonVersionOf(bin: string) {
  const r = await tryRun(bin, ['--version']);
  return (r.stdout || r.stderr).trim().replace(/^Python\s+/, '');
}

const pyEnv = () => ({ UV_PYTHON_INSTALL_DIR: PATHS.pythonRuntimes, UV_NO_PROGRESS: '1' });

/** 'system' 이면 /usr/bin/python3, 그 외 버전은 uv 로 설치 후 경로 */
export function ensurePython(spec: string, onLog: Logger = () => {}): Promise<string> {
  return mutex.run('python', async () => {
    if (!spec || spec === 'system') {
      const p = await systemPython();
      if (!p) throw new Error('시스템에 python3 가 없습니다 (apt install python3)');
      return p;
    }
    if (!/^\d+\.\d+(\.\d+)?$/.test(spec)) throw new Error(`잘못된 Python 버전: ${spec}`);
    const uv = await ensureUv(onLog);
    const found = await tryRun(uv, ['python', 'find', '--managed-python', spec], { env: pyEnv() });
    if (found.code === 0 && found.stdout.trim()) return found.stdout.trim();
    onLog(`Python ${spec} 설치 중 (uv)...`);
    await run(uv, ['python', 'install', '--no-bin', spec], { env: pyEnv(), onLine: (l) => l && onLog(l) });
    await run('chmod', ['-R', 'a+rX', PATHS.pythonRuntimes]);
    const r = await run(uv, ['python', 'find', '--managed-python', spec], { env: pyEnv() });
    return r.stdout.trim();
  });
}

export async function installedPythons() {
  const out: { version: string; path: string; managed: boolean }[] = [];
  const sys = await systemPython();
  if (sys) out.push({ version: await pythonVersionOf(sys), path: sys, managed: false });
  const uv = uvPath();
  if (uv) {
    const r = await tryRun(uv, ['python', 'list', '--only-installed', '--managed-python', '--output-format', 'json'], { env: pyEnv() });
    try {
      for (const p of JSON.parse(r.stdout) as { version: string; path: string }[]) {
        out.push({ version: p.version, path: p.path, managed: true });
      }
    } catch {
      /* 구버전 uv */
    }
  }
  return out;
}

export async function removePython(version: string) {
  const uv = uvPath();
  if (!uv) return;
  await run(uv, ['python', 'uninstall', version], { env: pyEnv() });
}

export { pyEnv };
