import fs from 'node:fs';
import path from 'node:path';
import { run, type RunOptions } from '../lib/exec.ts';
import type { Commit } from '../lib/types.ts';
import { HttpError } from '../lib/util.ts';
import type { Identity } from './users.ts';

export interface GitAuth {
  type: 'none' | 'token' | 'deploykey';
  token?: string;
  keyPath?: string;
}

/**
 * 'owner/repo', https URL, ssh URL 을 인증 방식에 맞는 형태로 바꾼다.
 * deploykey → git@host:owner/repo.git, 나머지 → https://host/owner/repo.git
 */
export function normalizeRepoUrl(input: string, authType: GitAuth['type']): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) throw new HttpError(400, '저장소 주소를 입력하세요');
  let host = 'github.com';
  let scheme = 'https';
  let repoPath = '';
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^([\w.-]+)\/([\w.-]+)$/))) {
    repoPath = `${m[1]}/${m[2]}`;
  } else if ((m = s.match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/))) {
    // http:// 는 내부망 자체 호스팅 git (Gitea 등) 용으로 그대로 둔다
    scheme = m[1]!;
    host = m[2]!;
    repoPath = m[3]!;
  } else if ((m = s.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/))) {
    host = m[1]!;
    repoPath = m[2]!;
  } else {
    throw new HttpError(400, '저장소 주소 형식을 알 수 없습니다 (예: owner/repo 또는 https://github.com/owner/repo)');
  }
  repoPath = repoPath.replace(/\.git$/, '');
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(repoPath)) throw new HttpError(400, '저장소 경로가 올바르지 않습니다');
  return authType === 'deploykey' ? `git@${host}:${repoPath}.git` : `${scheme}://${host}/${repoPath}.git`;
}

/** github.com 저장소인지. 설정의 GitHub 토큰은 GitHub 에만 보낸다 (다른 호스트로 새지 않게) */
export function isGithubUrl(url: string) {
  const s = url.trim();
  return /^[\w.-]+\/[\w.-]+$/.test(s) || /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])/i.test(s);
}

export function repoWebUrl(url: string) {
  const m = url.match(/^https?:\/\/([^/]+)\/(.+?)(\.git)?$/) ?? url.match(/^git@([^:]+):(.+?)(\.git)?$/);
  return m ? `${url.startsWith('http://') ? 'http' : 'https'}://${m[1]}/${m[2]}` : '';
}

function gitEnv(auth: GitAuth, id: Identity, url?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: id.home,
    USER: id.user,
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const cfg: [string, string][] = [
    ['safe.directory', '*'],
    ['advice.detachedHead', 'false'],
    ['core.quotePath', 'false'],
  ];
  if (auth.type === 'token' && auth.token) {
    let origin = 'https://github.com/';
    const m = url?.match(/^(https?:\/\/[^/]+\/)/);
    if (m) origin = m[1]!;
    const basic = Buffer.from(`x-access-token:${auth.token}`).toString('base64');
    // 토큰을 argv 대신 환경변수로 넘겨 ps 에 노출되지 않게 한다
    cfg.push([`http.${origin}.extraHeader`, `Authorization: Basic ${basic}`]);
  }
  if (auth.type === 'deploykey' && auth.keyPath) {
    const kh = path.join(id.home, '.ssh', 'known_hosts');
    env.GIT_SSH_COMMAND = [
      'ssh',
      `-i ${auth.keyPath}`,
      '-o IdentitiesOnly=yes',
      '-o BatchMode=yes',
      '-o StrictHostKeyChecking=accept-new',
      `-o UserKnownHostsFile=${kh}`,
      '-o ConnectTimeout=20',
    ].join(' ');
  }
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

export interface GitCtx {
  id: Identity;
  auth: GitAuth;
  url?: string;
  cwd?: string;
  onLine?: RunOptions['onLine'];
  timeoutMs?: number;
}

export async function git(args: string[], ctx: GitCtx) {
  if (ctx.auth.type === 'deploykey') fs.mkdirSync(path.join(ctx.id.home, '.ssh'), { recursive: true, mode: 0o700 });
  try {
    const r = await run('git', args, {
      cwd: ctx.cwd,
      env: gitEnv(ctx.auth, ctx.id, ctx.url),
      cleanEnv: true,
      uid: ctx.id.uid,
      gid: ctx.id.gid,
      onLine: ctx.onLine,
      timeoutMs: ctx.timeoutMs ?? 10 * 60_000,
    });
    return r.stdout;
  } catch (e) {
    throw new Error(friendlyGitError((e as Error).message));
  }
}

function friendlyGitError(msg: string) {
  if (/Repository not found|could not read Username|Authentication failed|403|terminal prompts disabled/i.test(msg)) {
    return `저장소에 접근할 수 없습니다. 비공개 저장소라면 GitHub 토큰이나 배포 키를 설정하세요. (${msg.split('\n').pop()})`;
  }
  if (/Permission denied \(publickey\)/.test(msg)) {
    return '배포 키가 GitHub 저장소에 등록되지 않았습니다. 저장소 Settings → Deploy keys 에 공개키를 추가하세요.';
  }
  if (/Could not resolve host|Connection timed out|Network is unreachable/i.test(msg)) {
    return `네트워크 오류: ${msg.split('\n').pop()}`;
  }
  return msg;
}

/** 원격 브랜치의 최신 커밋 sha (없으면 null) */
export async function lsRemote(url: string, branch: string, ctx: Omit<GitCtx, 'url'>): Promise<string | null> {
  const out = await git(['ls-remote', '--heads', url, `refs/heads/${branch}`], { ...ctx, url, timeoutMs: 60_000 });
  const line = out.split('\n').find((l) => l.endsWith(`refs/heads/${branch}`));
  return line ? line.split('\t')[0]! : null;
}

export async function listBranches(url: string, ctx: Omit<GitCtx, 'url'>) {
  const out = await git(['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], { ...ctx, url, timeoutMs: 60_000 });
  let defaultBranch = '';
  const branches: { name: string; sha: string }[] = [];
  for (const l of out.split('\n')) {
    const sym = l.match(/^ref: refs\/heads\/(.+)\tHEAD$/);
    if (sym) {
      defaultBranch = sym[1]!;
      continue;
    }
    const m = l.match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/);
    if (m) branches.push({ sha: m[1]!, name: m[2]! });
  }
  return { defaultBranch: defaultBranch || branches[0]?.name || 'main', branches };
}

export async function clone(url: string, branch: string, dir: string, ctx: Omit<GitCtx, 'url' | 'cwd'>, depth?: number) {
  const args = ['clone', '--progress', '--branch', branch, '--single-branch'];
  if (depth) args.push('--depth', String(depth));
  await git([...args, url, dir], { ...ctx, url });
}

/** origin/<branch> 를 갱신하고 그 sha 를 돌려준다. 작업 트리는 건드리지 않는다. */
export async function fetch(dir: string, url: string, branch: string, ctx: Omit<GitCtx, 'url' | 'cwd'>) {
  const quiet = { ...ctx, onLine: undefined };
  await git(['remote', 'set-url', 'origin', url], { ...quiet, cwd: dir, url });
  await git(['fetch', '--prune', '--progress', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    ...ctx,
    cwd: dir,
    url,
  });
  return (await git(['rev-parse', `refs/remotes/origin/${branch}`], { ...quiet, cwd: dir })).trim();
}

export async function headSha(dir: string, ctx: Omit<GitCtx, 'cwd'>) {
  try {
    return (await git(['rev-parse', 'HEAD'], { ...ctx, cwd: dir })).trim();
  } catch {
    return null;
  }
}

export async function hasCommit(dir: string, sha: string, ctx: Omit<GitCtx, 'cwd'>) {
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`], { ...ctx, cwd: dir });
    return true;
  } catch {
    return false;
  }
}

export async function log(dir: string, from: string | null, to: string, ctx: Omit<GitCtx, 'cwd'>, limit = 50): Promise<Commit[]> {
  const range = from ? `${from}..${to}` : to;
  let out = '';
  try {
    out = await git(['log', `-n${limit}`, '--format=%H%x1f%an%x1f%at%x1f%s%x1e', range], { ...ctx, cwd: dir });
  } catch {
    // from 이 히스토리에 없으면 (force push 등) 최신 몇 개만
    out = await git(['log', `-n${Math.min(limit, 10)}`, '--format=%H%x1f%an%x1f%at%x1f%s%x1e', to], { ...ctx, cwd: dir });
  }
  return out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [sha, author, at, message] = s.split('\x1f');
      return { sha: sha!, author: author ?? '', date: Number(at) * 1000, message: message ?? '' };
    });
}

export async function diffNames(dir: string, a: string, b: string, ctx: Omit<GitCtx, 'cwd'>) {
  const out = await git(['diff', '--name-only', '-z', a, b], { ...ctx, cwd: dir });
  return out.split('\0').filter(Boolean);
}

export async function diffStat(dir: string, a: string, b: string, ctx: Omit<GitCtx, 'cwd'>) {
  const out = await git(['diff', '--numstat', '-z', '-M', a, b], { ...ctx, cwd: dir });
  const res: { file: string; add: number; del: number }[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    let file = m[3]!;
    if (file === '') {
      // rename: 다음 두 항목이 old, new
      const oldF = parts[++i] ?? '';
      const newF = parts[++i] ?? '';
      file = `${oldF} → ${newF}`;
    }
    res.push({ file, add: m[1] === '-' ? -1 : Number(m[1]), del: m[2] === '-' ? -1 : Number(m[2]) });
  }
  return res;
}

export async function diffPatch(dir: string, a: string, b: string, file: string | null, ctx: Omit<GitCtx, 'cwd'>) {
  const args = ['diff', '--no-color', '-M', a, b];
  if (file) args.push('--', file);
  const out = await git(args, { ...ctx, cwd: dir });
  const max = 400_000;
  return out.length > max ? out.slice(0, max) + '\n\n... (너무 길어서 잘렸습니다)' : out;
}

export async function lsTree(dir: string, sha: string, ctx: Omit<GitCtx, 'cwd'>) {
  const out = await git(['ls-tree', '-r', '-z', '--name-only', sha], { ...ctx, cwd: dir });
  return new Set(out.split('\0').filter(Boolean));
}

/** 작업 트리에서 수정/삭제된 추적 파일 */
export async function locallyModified(dir: string, ctx: Omit<GitCtx, 'cwd'>) {
  const out = await git(['diff', '--name-only', '-z', 'HEAD'], { ...ctx, cwd: dir });
  return out.split('\0').filter(Boolean);
}

/** gitignore 스타일 패턴을 git pathspec(:(glob)) 으로 */
export function toPathspec(pattern: string) {
  let p = pattern.trim().replace(/^\.\//, '');
  if (!p || p.startsWith('#')) return null;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  if (!anchored && !p.includes('/')) p = `**/${p}`;
  return `:(glob)${p}`;
}

/** 패턴에 맞는 파일 (추적 + 미추적 + ignore 포함) */
export async function filesMatching(dir: string, patterns: string[], ctx: Omit<GitCtx, 'cwd'>) {
  const specs = patterns.map(toPathspec).filter((s): s is string => !!s);
  if (!specs.length) return [];
  const out = await git(['ls-files', '-z', '--cached', '--others', '--', ...specs], { ...ctx, cwd: dir });
  return [...new Set(out.split('\0').filter(Boolean))];
}

/** 패턴 매칭 (파일 경로 하나) — git 과 같은 규칙을 JS 로 */
export function matchesAny(file: string, patterns: string[]) {
  return patterns.some((pat) => {
    const spec = toPathspec(pat);
    if (!spec) return false;
    return globToRegex(spec.slice(':(glob)'.length)).test(file);
  });
}

export function globToRegex(glob: string) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // **/ 는 0개 이상의 디렉터리, 끝의 ** 는 모든 것
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** 작업 트리를 sha 로 맞춘다 (git clean 은 하지 않으므로 미추적 파일은 그대로) */
export async function checkoutForce(dir: string, branch: string, sha: string, ctx: Omit<GitCtx, 'cwd'>) {
  await git(['checkout', '--quiet', '-f', '-B', branch, sha], { ...ctx, cwd: dir });
  await git(['submodule', 'update', '--init', '--recursive'], { ...ctx, cwd: dir }).catch(() => {});
}
