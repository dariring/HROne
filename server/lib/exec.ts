import { spawn, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** process.env 를 상속하지 않고 env 만 사용 */
  cleanEnv?: boolean;
  uid?: number;
  gid?: number;
  input?: string | Buffer;
  timeoutMs?: number;
  /** stdout/stderr 를 줄 단위로 받는다 (배포 로그 스트리밍용) */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** 0 이 아닌 종료 코드도 예외 없이 반환 */
  allowFail?: boolean;
  /** 출력 버퍼 최대 크기 (바이트). 초과분은 앞부분을 버린다. */
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ExecError extends Error {
  code: number;
  stdout: string;
  stderr: string;
  constructor(cmd: string, res: RunResult) {
    const tail = (res.stderr || res.stdout).trim().split('\n').slice(-8).join('\n');
    super(`${cmd} 실패 (code ${res.code})${tail ? `: ${tail}` : ''}`);
    this.code = res.code;
    this.stdout = res.stdout;
    this.stderr = res.stderr;
  }
}

const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function run(cmd: string, args: string[] = [], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = opts.cleanEnv ? { PATH: BASE_PATH, ...opts.env } : { ...process.env, ...opts.env };
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: opts.signal,
    };
    if (opts.uid !== undefined) spawnOpts.uid = opts.uid;
    if (opts.gid !== undefined) spawnOpts.gid = opts.gid;
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      reject(e);
      return;
    }
    const max = opts.maxBuffer ?? 8 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    const partial = { stdout: '', stderr: '' };
    // 청크 경계에서 한글 등 멀티바이트 문자가 깨지지 않게
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const s = decoders[stream].write(chunk);
      if (stream === 'stdout') {
        stdout += s;
        if (stdout.length > max) stdout = stdout.slice(-max);
      } else {
        stderr += s;
        if (stderr.length > max) stderr = stderr.slice(-max);
      }
      if (opts.onLine) {
        const buf = partial[stream] + s;
        const lines = buf.split(/\r?\n|\r/);
        partial[stream] = lines.pop() ?? '';
        for (const l of lines) opts.onLine(l, stream);
      }
    };
    child.stdout!.on('data', onData('stdout'));
    child.stderr!.on('data', onData('stderr'));
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      if (opts.onLine) {
        if (partial.stdout) opts.onLine(partial.stdout, 'stdout');
        if (partial.stderr) opts.onLine(partial.stderr, 'stderr');
      }
      const res = { code: code ?? (signal ? 128 : 1), stdout, stderr };
      if (res.code !== 0 && !opts.allowFail) {
        reject(new ExecError([cmd, ...args].join(' ').slice(0, 200), res));
      } else {
        resolve(res);
      }
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/** bash -c 로 실행 */
export function sh(script: string, opts: RunOptions = {}) {
  return run('/bin/bash', ['-c', script], opts);
}

/** 실패해도 결과만 돌려준다 */
export async function tryRun(cmd: string, args: string[] = [], opts: RunOptions = {}) {
  try {
    return await run(cmd, args, { ...opts, allowFail: true });
  } catch (e) {
    return { code: 127, stdout: '', stderr: String((e as Error).message) };
  }
}

export async function which(bin: string): Promise<string | null> {
  const r = await tryRun('/bin/sh', ['-c', `command -v ${bin}`]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** 셸 단일 인자 이스케이프 */
export function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
