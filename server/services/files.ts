import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../lib/util.ts';

/**
 * 앱 폴더 안의 파일을 읽기 전용으로 보여 준다.
 * 패널은 root 로 돌기 때문에, 모든 경로를 앱 폴더 안으로 가둔다 (../ 와 바깥을 가리키는 심볼릭 링크 모두).
 */

export interface FileEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
  /** 심볼릭 링크가 가리키는 곳 (앱 폴더 기준 상대 경로, 바깥이면 null) */
  target?: string | null;
}

const MAX_ENTRIES = 3000;
const PREVIEW_BYTES = 1024 * 1024;

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** 앱 폴더 기준 상대 경로 → 실제 경로. 바깥으로 나가면 400 */
export function resolveInside(rootDir: string, rel: string) {
  if (rel.includes('\0')) throw new HttpError(400, '잘못된 경로');
  const root = fs.realpathSync(rootDir);
  const target = path.resolve(root, '.' + path.sep + String(rel ?? '').replace(/^[/\\]+/, ''));
  if (!inside(root, target)) throw new HttpError(400, '앱 폴더 밖은 볼 수 없습니다');
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw new HttpError(404, '파일이 없습니다');
  }
  if (!inside(root, real)) throw new HttpError(400, '앱 폴더 밖을 가리키는 링크는 열 수 없습니다');
  return { root, abs: real, rel: path.relative(root, real).split(path.sep).join('/') };
}

export function listDir(rootDir: string, rel: string) {
  const { root, abs, rel: clean } = resolveInside(rootDir, rel);
  if (!fs.statSync(abs).isDirectory()) throw new HttpError(400, '폴더가 아닙니다');
  const names = fs.readdirSync(abs);
  const entries: FileEntry[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const p = path.join(abs, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      let target: string | null = null;
      let isDir = false;
      try {
        const real = fs.realpathSync(p);
        if (inside(root, real)) {
          target = path.relative(root, real).split(path.sep).join('/');
          isDir = fs.statSync(real).isDirectory();
        }
      } catch {
        /* 끊어진 링크 */
      }
      entries.push({ name, type: target !== null && isDir ? 'dir' : 'link', size: 0, mtime: st.mtimeMs, target });
      continue;
    }
    entries.push({ name, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.isFile() ? st.size : 0, mtime: st.mtimeMs });
  }
  entries.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  return { path: clean, entries, truncated: names.length > MAX_ENTRIES };
}

/** 미리보기: 1MB 까지, 앞부분에 NUL 이 있으면 바이너리로 본다 */
export function readPreview(rootDir: string, rel: string) {
  const { abs, rel: clean } = resolveInside(rootDir, rel);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new HttpError(400, '파일이 아닙니다');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, PREVIEW_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, Math.min(n, 8000));
    const binary = head.includes(0);
    return {
      path: clean,
      size: st.size,
      mtime: st.mtimeMs,
      binary,
      truncated: st.size > PREVIEW_BYTES,
      text: binary ? null : buf.subarray(0, n).toString('utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 내려받을 때 브라우저가 한글 파일명도 그대로 쓰게 */
export function attachmentHeader(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 폴더를 tar.gz 로 흘려보낸다. node_modules / .venv 같은 설치물은 뺄 수 있다.
 * 돌려준 kill 은 클라이언트가 중간에 끊었을 때 부른다.
 */
export function tarStream(abs: string, opts: { skipDeps: boolean }) {
  const args = ['-czf', '-'];
  if (opts.skipDeps) args.push('--exclude=node_modules', '--exclude=.venv', '--exclude=__pycache__');
  args.push('-C', path.dirname(abs), path.basename(abs));
  const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  return { stream: child.stdout, kill: () => child.kill('SIGTERM') };
}
