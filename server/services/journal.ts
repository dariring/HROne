import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { Writable } from 'node:stream';
import { run, tryRun } from '../lib/exec.ts';

export interface LogEntry {
  /** ms epoch */
  t: number;
  m: string;
  /** a = 앱 출력, s = systemd, h = HROne 패널 */
  s: 'a' | 's' | 'h';
  /** syslog priority (3 = err, 4 = warning, 6 = info) */
  p: number;
}

function matches(unit: string) {
  return [`_SYSTEMD_UNIT=${unit}`, '+', `UNIT=${unit}`, '+', `HRONE_UNIT=${unit}`];
}

function field(v: unknown): string {
  if (typeof v === 'string') return v;
  // 제어문자(ANSI 색 등)가 들어간 메시지는 바이트 배열로 온다
  if (Array.isArray(v)) return Buffer.from(v as number[]).toString('utf8');
  return v === undefined || v === null ? '' : String(v);
}

function parse(line: string): LogEntry | null {
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    const t = Math.floor(Number(field(j.__REALTIME_TIMESTAMP)) / 1000);
    let s: LogEntry['s'] = 'a';
    if (j.HRONE_UNIT) s = 'h';
    else if (field(j._PID) === '1' || field(j.SYSLOG_IDENTIFIER) === 'systemd') s = 's';
    return { t, m: field(j.MESSAGE).replace(/\n$/, ''), s, p: Number(field(j.PRIORITY) || 6) };
  } catch {
    return null;
  }
}

export async function recent(unit: string, lines = 500, sinceMs?: number): Promise<LogEntry[]> {
  const args = ['--no-pager', '-o', 'json', '-n', String(lines)];
  if (sinceMs) args.push(`--since=@${Math.floor(sinceMs / 1000)}`);
  const r = await tryRun('journalctl', [...args, ...matches(unit)], { maxBuffer: 64 * 1024 * 1024 });
  const out: LogEntry[] = [];
  for (const l of r.stdout.split('\n')) {
    if (!l) continue;
    const e = parse(l);
    if (e) out.push(e);
  }
  return out;
}

/** 실시간 구독. 반환값을 호출하면 중지 */
export function follow(unit: string, onEntry: (e: LogEntry) => void): () => void {
  const child = spawn('journalctl', ['--no-pager', '-o', 'json', '-f', '-n', '0', ...matches(unit)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (l) => {
    const e = parse(l);
    if (e) onEntry(e);
  });
  child.on('error', () => {});
  return () => {
    rl.close();
    child.kill('SIGTERM');
  };
}

/** 사람이 읽는 형식으로 내려받기 */
export function exportTo(unit: string, out: Writable, sinceMs?: number) {
  const args = ['--no-pager', '-o', 'short-iso', '--all'];
  if (sinceMs) args.push(`--since=@${Math.floor(sinceMs / 1000)}`);
  const child = spawn('journalctl', [...args, ...matches(unit)], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.pipe(out);
  return child;
}

/** 앱 콘솔에 패널 메시지를 남긴다 (journal 에 HRONE_UNIT 필드로 기록) */
export async function mark(unit: string, message: string, priority = 6) {
  const msg = message.replace(/\r?\n/g, ' ');
  const input = `HRONE_UNIT=${unit}\nSYSLOG_IDENTIFIER=hrone\nPRIORITY=${priority}\nMESSAGE=${msg}\n`;
  await tryRun('logger', ['--journald'], { input, timeoutMs: 5000 });
}

export async function diskUsage() {
  const r = await tryRun('journalctl', ['--disk-usage']);
  return r.stdout.trim();
}

export async function vacuum(size: string) {
  await run('journalctl', [`--vacuum-size=${size}`]);
}
