import fs from 'node:fs';
import { run, tryRun } from '../lib/exec.ts';

export interface Identity {
  user: string;
  uid: number;
  gid: number;
  home: string;
}

const ROOT_ID: Identity = { user: 'root', uid: 0, gid: 0, home: '/root' };

function lookup(user: string): { uid: number; gid: number } | null {
  try {
    for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const p = line.split(':');
      if (p[0] === user) return { uid: Number(p[2]), gid: Number(p[3]) };
    }
  } catch {
    /* noop */
  }
  return null;
}

/** 시스템 계정이 없으면 만든다 (로그인 불가, 홈은 패널이 관리) */
export async function ensureUser(user: string, home: string): Promise<Identity & { created: boolean }> {
  if (user === 'root') return { ...ROOT_ID, created: false };
  let id = lookup(user);
  const created = !id;
  if (!id) {
    await run('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', user]);
    id = lookup(user);
    if (!id) throw new Error(`계정 생성 실패: ${user}`);
  }
  fs.mkdirSync(home, { recursive: true });
  fs.chownSync(home, id.uid, id.gid);
  fs.chmodSync(home, 0o700);
  return { user, ...id, home, created };
}

export function identity(user: string, home: string): Identity {
  if (user === 'root') return ROOT_ID;
  const id = lookup(user);
  if (!id) throw new Error(`계정이 없습니다: ${user}`);
  return { user, ...id, home };
}

export async function deleteUser(user: string) {
  if (user === 'root' || !user.startsWith('hr-')) return;
  await tryRun('pkill', ['-KILL', '-u', user]);
  await tryRun('userdel', [user]);
}

/** 디렉터리 전체 소유자 변경 */
export async function chownR(dir: string, id: Identity) {
  await run('chown', ['-R', `${id.uid}:${id.gid}`, dir]);
}
