/**
 * 서버에서 직접 쓰는 관리 명령 (scripts/hrone 이 호출).
 *   reset-password [아이디]   비밀번호 초기화 (없으면 계정 생성), 새 비밀번호 출력
 *   disable-2fa <아이디>      OTP 해제
 *   allow-all-ips            접속 IP 제한 해제 (잠겼을 때)
 *   private-ips              접속 IP 를 사설망/Tailscale 로 제한
 *   set-port <포트>
 *   info                     접속 주소 출력
 */
import os from 'node:os';
import { hashPassword, randomPassword } from './lib/crypto.ts';
import { now, openDb, q } from './lib/db.ts';
import { settings } from './lib/settings.ts';

openDb();
const [cmd, arg] = process.argv.slice(2);

function addresses(port: number) {
  const out: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tag = name.startsWith('tailscale') || a.address.startsWith('100.') ? ' (Tailscale)' : '';
      out.push(`http://${a.address}:${port}${tag}`);
    }
  }
  // install.sh / hrone 은 sudo 로 돌기 때문에 SSH 로 들어온 계정은 SUDO_USER 에 있다
  const who = process.env.SUDO_USER && process.env.SUDO_USER !== 'root' ? `${process.env.SUDO_USER}@` : '';
  out.push(`http://127.0.0.1:${port} (내 PC 에서: ssh -L ${port}:127.0.0.1:${port} ${who}<서버 주소>  후 http://localhost:${port})`);
  return out;
}

switch (cmd) {
  case 'reset-password': {
    const username = arg || 'admin';
    const pw = randomPassword(16);
    const u = q.get<{ id: number }>('SELECT id FROM users WHERE username = ?', username);
    if (u) {
      q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(pw), u.id);
      q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    } else {
      q.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', username, hashPassword(pw), now());
    }
    console.log(`아이디: ${username}`);
    console.log(`비밀번호: ${pw}`);
    break;
  }
  case 'ensure-admin': {
    const n = q.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
    if (n === 0) {
      const pw = randomPassword(16);
      q.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', 'admin', hashPassword(pw), now());
      console.log(`NEW admin ${pw}`);
    } else console.log('EXISTS');
    break;
  }
  case 'disable-2fa': {
    if (!arg) throw new Error('아이디를 지정하세요');
    const r = q.run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL WHERE username = ?', arg);
    console.log(r.changes ? `${arg} 의 OTP 를 해제했습니다` : '그런 아이디가 없습니다');
    break;
  }
  case 'allow-all-ips': {
    settings.setPanel({ ...settings.panel(), access: 'all' });
    console.log('모든 IP 에서 접속 가능하도록 바꿨습니다. 패널을 재시작합니다.');
    break;
  }
  case 'private-ips': {
    settings.setPanel({ ...settings.panel(), access: 'private' });
    console.log('사설망/Tailscale/로컬에서만 접속 가능하도록 바꿨습니다.');
    break;
  }
  case 'set-port': {
    const p = Number(arg);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('포트 번호가 올바르지 않습니다');
    settings.setPanel({ ...settings.panel(), port: p });
    console.log(`패널 포트를 ${p} 로 바꿨습니다.`);
    break;
  }
  case 'info': {
    const s = settings.panel();
    console.log(`접속 제한: ${s.access === 'private' ? '사설망/Tailscale/로컬만' : s.access === 'all' ? '모든 IP' : s.allowedCidrs.join(', ')}`);
    for (const a of addresses(s.port)) console.log(`  ${a}`);
    break;
  }
  default:
    console.log('사용법: hrone-cli <reset-password|disable-2fa|allow-all-ips|private-ips|set-port|info>');
    process.exit(1);
}
