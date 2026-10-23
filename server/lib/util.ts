import fs from 'node:fs';
import path from 'node:path';

export const SLUG_RE = /^[a-z][a-z0-9-]{1,23}$/;

export function assertSlug(slug: string) {
  if (!SLUG_RE.test(slug) || slug.endsWith('-') || slug.includes('--')) {
    throw new HttpError(400, 'ID는 영문 소문자로 시작하는 2~24자 (소문자/숫자/-) 여야 합니다');
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 같은 키에 대한 작업을 순서대로 실행 */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.chains.set(key, next);
    next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    }).catch(() => {});
    return next;
  }
  busy(key: string) {
    return this.chains.has(key);
  }
}

/** 내용이 다를 때만 원자적으로 쓴다. 바뀌었으면 true */
export function writeFileIfChanged(file: string, content: string, mode = 0o644): boolean {
  try {
    if (fs.readFileSync(file, 'utf8') === content) {
      fs.chmodSync(file, mode);
      return false;
    }
  } catch {
    /* 없음 */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  return true;
}

export function rmrf(p: string) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function dirSize(p: string): number {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e));
      } catch {
        /* noop */
      }
    } else total += st.size;
  }
  return total;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

export function clampInt(v: unknown, min: number, max: number, def: number) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : '-';
}
