import type { FastifyInstance } from 'fastify';
import { audit } from '../../lib/audit.ts';
import { encrypt, hashPassword, newTotpSecret, verifyPassword, verifyTotp } from '../../lib/crypto.ts';
import { now, q } from '../../lib/db.ts';
import { HttpError } from '../../lib/util.ts';
import {
  actor,
  checkThrottle,
  clearFailures,
  createSession,
  destroySession,
  reauth,
  recordFailure,
  totpSecretOf,
  type UserRow,
} from '../auth.ts';

type Body = Record<string, any>;

export function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, totpEnabled: !!u.totp_enabled, createdAt: u.created_at, lastLoginAt: u.last_login_at };
}

function validatePassword(pw: unknown) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다');
  if (pw.length > 200) throw new HttpError(400, '비밀번호가 너무 깁니다');
}

export function registerAuth(app: FastifyInstance) {
  app.get('/api/auth/state', async (req) => {
    const count = q.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;
    return { hasUsers: count > 0, user: req.user ? publicUser(req.user) : null };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    checkThrottle(req.clientIp);
    const user = q.get<UserRow>('SELECT * FROM users WHERE username = ?', String(b.username ?? '').trim());
    if (!user || typeof b.password !== 'string' || !verifyPassword(b.password, user.password_hash)) {
      recordFailure(req.clientIp);
      audit({ username: String(b.username ?? '').slice(0, 40), ip: req.clientIp }, 'auth.login_failed');
      throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다');
    }
    if (user.totp_enabled) {
      if (!b.totp) return { needTotp: true };
      if (!verifyTotp(totpSecretOf(user), String(b.totp))) {
        recordFailure(req.clientIp);
        throw new HttpError(401, 'OTP 코드가 올바르지 않습니다');
      }
    }
    clearFailures(req.clientIp);
    createSession(user, req, reply);
    audit({ username: user.username, ip: req.clientIp }, 'auth.login');
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: publicUser(req.user!) }));

  app.post('/api/auth/password', async (req) => {
    const b = (req.body ?? {}) as Body;
    reauth(req, b.current, b.totp);
    validatePassword(b.next);
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(b.next), req.user!.id);
    q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user!.id, req.sessionId!);
    audit(actor(req), 'auth.password_change');
    return { ok: true };
  });

  // OTP 설정: begin 으로 비밀키를 받고, 앱에 등록 후 enable 로 코드 확인
  app.post('/api/auth/totp/begin', async (req) => {
    const secret = newTotpSecret();
    const label = encodeURIComponent(`HROne:${req.user!.username}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=HROne&algorithm=SHA1&digits=6&period=30` };
  });

  app.post('/api/auth/totp/enable', async (req) => {
    const b = (req.body ?? {}) as Body;
    if (typeof b.secret !== 'string' || !/^[A-Z2-7]{16,64}$/.test(b.secret)) throw new HttpError(400, '잘못된 비밀키');
    if (!verifyTotp(b.secret, String(b.code ?? ''))) throw new HttpError(400, 'OTP 코드가 맞지 않습니다. 앱의 현재 코드를 입력하세요.');
    q.run('UPDATE users SET totp_secret_enc = ?, totp_enabled = 1 WHERE id = ?', encrypt(b.secret), req.user!.id);
    audit(actor(req), 'auth.totp_enable');
    return { ok: true };
  });

  app.post('/api/auth/totp/disable', async (req) => {
    const b = (req.body ?? {}) as Body;
    reauth(req, b.password, b.totp);
    q.run('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ?', req.user!.id);
    audit(actor(req), 'auth.totp_disable');
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req) => {
    const rows = q.all<{ id: string; created_at: number; last_seen_at: number; ip: string; user_agent: string }>(
      'SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
      req.user!.id,
      now(),
    );
    return rows.map((r) => ({ ...r, id: r.id.slice(0, 16), current: r.id === req.sessionId }));
  });

  app.delete('/api/auth/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    q.run("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ? AND id != ?", req.user!.id, id, req.sessionId!);
    return { ok: true };
  });

  // ---------- 사용자 관리 ----------

  app.get('/api/users', async () => q.all<UserRow>('SELECT * FROM users ORDER BY id').map(publicUser));

  app.post('/api/users', async (req) => {
    const b = (req.body ?? {}) as Body;
    const username = String(b.username ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw new HttpError(400, '아이디는 영문/숫자/_.- 3~32자');
    validatePassword(b.password);
    if (q.get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, '이미 있는 아이디입니다');
    q.run('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)', username, hashPassword(b.password), now());
    audit(actor(req), 'user.create', username);
    return { ok: true };
  });

  app.post('/api/users/:id/delete', async (req) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Body;
    reauth(req, b.password, b.totp);
    if (Number(id) === req.user!.id) throw new HttpError(400, '자기 자신은 삭제할 수 없습니다');
    const u = q.get<UserRow>('SELECT * FROM users WHERE id = ?', Number(id));
    if (!u) throw new HttpError(404, '사용자가 없습니다');
    q.run('DELETE FROM users WHERE id = ?', u.id);
    audit(actor(req), 'user.delete', u.username);
    return { ok: true };
  });
}
