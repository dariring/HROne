import os from 'node:os';
import { HttpError } from '../lib/util.ts';
import * as git from './git.ts';

/**
 * 패널에서 고친 파일을 커밋·푸시한다.
 * 배포는 작업 폴더를 원격 브랜치와 같은 이름의 로컬 브랜치로 맞춰 두므로(checkout -f -B),
 * 그 위에 커밋하고 HEAD 를 원격 브랜치로 올린다. 올라가면 평소 푸시처럼 배포 흐름을 탄다.
 */

export interface ChangedFile {
  path: string;
  /** git status 두 글자 (예: ' M', '??', ' D', 'A ') */
  code: string;
  kind: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'other';
}

export interface RepoCtx {
  dir: string;
  branch: string;
  url: string;
  ctx: Omit<git.GitCtx, 'cwd' | 'url'>;
}

const MAX_FILES = 500;

function kindOf(code: string): ChangedFile['kind'] {
  if (code === '??') return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  if (code.includes('M') || code.includes('T')) return 'modified';
  return 'other';
}

/** git status --porcelain=v1 -z 출력 */
export function parseStatus(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    files.push({ path: p.slice(3), code, kind: kindOf(code) });
    // 이름 바꾸기는 다음 칸에 예전 이름이 온다
    if (code.includes('R') || code.includes('C')) i++;
  }
  return files;
}

export async function status(r: RepoCtx) {
  const run = (args: string[]) => git.git(args, { ...r.ctx, cwd: r.dir, url: r.url });
  const files = parseStatus(await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const head = (await run(['rev-parse', '--short', 'HEAD'])).trim();
  // 마지막으로 받아 온 원격 브랜치보다 앞선(아직 안 올린) 커밋 수
  const ahead = Number((await run(['rev-list', '--count', `refs/remotes/origin/${r.branch}..HEAD`]).catch(() => '0')).trim()) || 0;
  const unpushed = ahead
    ? (await run(['log', '--format=%h%x1f%s', `refs/remotes/origin/${r.branch}..HEAD`, '-n', '20']))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [sha, message] = l.split('\x1f');
          return { sha: sha!, message: message! };
        })
    : [];
  return { branch: r.branch, head, ahead, unpushed, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

export async function commit(r: RepoCtx, paths: string[], message: string, author: string) {
  const msg = message.trim();
  if (!msg) throw new HttpError(400, '커밋 메시지를 입력하세요');
  if (!paths.length) throw new HttpError(400, '커밋할 파일을 고르세요');
  const run = (args: string[]) => git.git(args, { ...r.ctx, cwd: r.dir, url: r.url });
  // 지금 바뀐 파일 중에서만 고를 수 있다 (경로를 그대로 git 에 넘기지 않기 위해)
  const changed = new Set(parseStatus(await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).map((f) => f.path));
  const bad = paths.filter((p) => !changed.has(p));
  if (bad.length) throw new HttpError(400, `바뀐 파일이 아닙니다: ${bad.slice(0, 3).join(', ')}`);
  await run(['reset', '--quiet']);
  await run(['add', '--all', '--', ...paths.map((p) => `:(literal)${p}`)]);
  await run(['-c', `user.name=${author} (HROne)`, '-c', `user.email=hrone@${os.hostname()}`, 'commit', '--quiet', '--no-verify', '-m', msg]);
  return (await run(['rev-parse', '--short', 'HEAD'])).trim();
}

export async function push(r: RepoCtx) {
  const run = (args: string[], timeoutMs?: number) => git.git(args, { ...r.ctx, cwd: r.dir, url: r.url, timeoutMs });
  if (r.ctx.auth.type === 'none') {
    throw new HttpError(400, '이 앱은 인증 없이(공개 저장소로) 연결되어 있어 올릴 수 없습니다. 앱 설정 → 저장소에서 GitHub 토큰이나 배포 키로 바꾸세요.');
  }
  // 그사이 GitHub 에 새 커밋이 올라왔으면 덮어쓰지 않는다
  await git.fetch(r.dir, r.url, r.branch, r.ctx);
  const ff = await run(['merge-base', '--is-ancestor', `refs/remotes/origin/${r.branch}`, 'HEAD']).then(
    () => true,
    () => false,
  );
  if (!ff) throw new HttpError(409, `GitHub 의 ${r.branch} 에 여기 없는 새 커밋이 있습니다. 먼저 그 커밋을 배포(받기)한 뒤 다시 고쳐서 올리세요.`);
  try {
    await run(['push', '--porcelain', r.url, `HEAD:refs/heads/${r.branch}`], 120_000);
  } catch (e) {
    const m = (e as Error).message;
    if (/denied|403|not allowed|read only|write access|protected branch/i.test(m)) {
      throw new HttpError(
        403,
        r.ctx.auth.type === 'token'
          ? '올릴 권한이 없습니다. GitHub 토큰에 이 저장소의 Contents: Read and write 권한을 주세요.'
          : '올릴 권한이 없습니다. GitHub 저장소 Settings → Deploy keys 에서 이 키의 "Allow write access" 를 켜세요.',
      );
    }
    throw e;
  }
  // 올린 커밋을 원격 브랜치 기준점으로 기록 (다음 상태 확인에서 "안 올린 커밋" 이 0 이 되게)
  await run(['update-ref', `refs/remotes/origin/${r.branch}`, 'HEAD']);
  return (await run(['rev-parse', 'HEAD'])).trim();
}

/**
 * 배포가 작업 폴더를 원격 커밋으로 바꾸기 전에 부른다.
 * 패널에서 커밋했지만 올리지 못한 커밋이 있으면(HEAD 가 target 의 조상이 아니면) 브랜치로 남겨
 * 체크아웃 뒤에도 잃어버리지 않게 하고, 그 커밋들이 바꾼 파일 목록을 돌려준다(백업용).
 */
export async function keepUnpushed(dir: string, head: string, target: string, ctx: Omit<git.GitCtx, 'cwd'>, tag: string) {
  if (head === target) return null;
  const run = (args: string[]) => git.git(args, { ...ctx, cwd: dir });
  const ancestor = await run(['merge-base', '--is-ancestor', head, target]).then(
    () => true,
    () => false,
  );
  if (ancestor) return null;
  const ref = `hrone/unpushed-${tag}`;
  await run(['branch', '-f', ref, head]);
  const base = (await run(['merge-base', head, target]).catch(() => '')).trim();
  const files = base ? (await run(['diff', '--name-only', '-z', base, head])).split('\0').filter(Boolean) : [];
  return { ref, files };
}
