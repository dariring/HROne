import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../lib/audit.ts';
import { decrypt, randomToken, sha256, verifyPassword, verifyTotp } from '../lib/crypto.ts';
import { now, q } from '../lib/db.ts';
import { settings } from '../lib/settings.ts';
import { HttpError } from '../lib/util.ts';

export const COOKIE = 'hrone_sid';
const TTL = 7 * 24 * 3600_000;

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  created_at: number;
  last_login_at: number | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    sessionId?: string;
    clientIp: string;
  }
}

// ---------- IP ----------

function parseV4(ip: string): bigint | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0n;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s) || Number(s) > 255) return null;
    n = (n << 8n) | BigInt(Number(s));
  }
  return n;
}

function parseV6(ip: string): bigint | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = parseV4(v4[1]!);
    if (n === null) return null;
    s = s.slice(0, -v4[1]!.length) + ((n >> 16n) & 0xffffn).toString(16) + ':' + (n & 0xffffn).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** ::ffff:1.2.3.4 → 1.2.3.4 */
export function normalizeIp(ip: string) {
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1]! : ip;
}

export function inCidr(ipRaw: string, cidr: string): boolean {
  const ip = normalizeIp(ipRaw);
  const [base, bitsStr] = cidr.trim().split('/');
  if (!base) return false;
  const isV4 = base.includes('.') && !base.includes(':');
  const maxBits = isV4 ? 32 : 128;
  const bits = bitsStr === undefined ? maxBits : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return false;
  const a = isV4 ? parseV4(ip) : ip.includes(':') ? parseV6(ip) : null;
  const b = isV4 ? parseV4(base) : parseV6(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const shift = BigInt(maxBits - bits);
  return a >> shift === b >> shift;
}

export const PRIVATE_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10', // Tailscale (CGNAT)
  '169.254.0.0/16',
  'fc00::/7', // ULA (Tailscale IPv6 fd7a:115c:a1e0::/48 포함)
  'fe80::/10',
];

export function isLoopback(ip: string) {
  return inCidr(ip, '127.0.0.0/8') || inCidr(ip, '::1/128');
}

export function ipAllowed(ip: string) {
  const s = settings.panel();
  if (isLoopback(ip)) return true;
  if (s.access === 'all') return true;
  const list = s.access === 'custom' ? s.allowedCidrs : PRIVATE_CIDRS;
  return list.some((c) => inCidr(ip, c));
}

/**
 * 실제 클라이언트 IP. 같은 서버의 cloudflared/리버스 프록시를 거쳐 온 요청은 헤더의 IP 를 쓴다
 * (그래야 터널로 들어온 외부 요청이 127.0.0.1 로 위장되지 않는다).
 */
export function clientIp(req: FastifyRequest) {
  const sock = normalizeIp(req.socket.remoteAddress ?? '');
  if (isLoopback(sock)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return normalizeIp(cf.trim());
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return normalizeIp(xff.split(',')[0]!.trim());
  }
  return sock;
}

// ---------- 세션 ----------

export function createSession(user: UserRow, req: FastifyRequest, reply: FastifyReply) {
  const token = randomToken(32);
  const t = now();
  q.run(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    user.id,
    t,
    t + TTL,
    t,
    req.clientIp,
    String(req.headers['user-agent'] ?? '').slice(0, 300),
  );
  q.run('UPDATE users SET last_login_at = ? WHERE id = ?', t, user.id);
  q.run('DELETE FROM sessions WHERE expires_at < ?', t);
  reply.setCookie(COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
    maxAge: TTL / 1000,
  });
}

export function loadSession(req: FastifyRequest) {
  const token = req.cookies[COOKIE];
  if (!token) return;
  const id = sha256(token);
  const row = q.get<{ user_id: number; expires_at: number; last_seen_at: number }>(
    'SELECT user_id, expires_at, last_seen_at FROM sessions WHERE id = ?',
    id,
  );
  if (!row || row.expires_at < now()) return;
  const user = q.get<UserRow>('SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user) return;
  req.user = user;
  req.sessionId = id;
  if (now() - row.last_seen_at > 5 * 60_000) {
    q.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?', now(), now() + TTL, req.clientIp, id);
  }
}

export function destroySession(req: FastifyRequest, reply: FastifyReply) {
  if (req.sessionId) q.run('DELETE FROM sessions WHERE id = ?', req.sessionId);
  reply.clearCookie(COOKIE, { path: '/' });
}

// ---------- 로그인 시도 제한 ----------

const attempts = new Map<string, { n: number; until: number; first: number }>();

export function checkThrottle(ip: string) {
  const a = attempts.get(ip);
  if (a && a.until > now()) {
    throw new HttpError(429, `로그인 시도가 너무 많습니다. ${Math.ceil((a.until - now()) / 1000)}초 뒤에 다시 시도하세요.`);
  }
}

export function recordFailure(ip: string) {
  const t = now();
  const a = attempts.get(ip);
  if (!a || t - a.first > 10 * 60_000) {
    attempts.set(ip, { n: 1, until: 0, first: t });
    return;
  }
  a.n++;
  if (a.n >= 5) a.until = t + Math.min(30 * 60_000, 60_000 * 2 ** (a.n - 5));
}

export function clearFailures(ip: string) {
  attempts.delete(ip);
}

// ---------- 확인 ----------

export function totpSecretOf(user: UserRow) {
  return user.totp_secret_enc ? decrypt(user.totp_secret_enc) : '';
}

/** 위험한 작업 전 비밀번호(+OTP) 재확인 */
export function reauth(req: FastifyRequest, password: unknown, totp: unknown) {
  const user = req.user;
  if (!user) throw new HttpError(401, '로그인이 필요합니다');
  checkThrottle(req.clientIp);
  if (typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
    recordFailure(req.clientIp);
    throw new HttpError(403, '비밀번호가 올바르지 않습니다');
  }
  if (user.totp_enabled) {
    if (typeof totp !== 'string' || !verifyTotp(totpSecretOf(user), totp)) {
      recordFailure(req.clientIp);
      throw new HttpError(403, 'OTP 코드가 올바르지 않습니다');
    }
  }
}

export function actor(req: FastifyRequest): Actor {
  return { username: req.user?.username ?? 'anonymous', ip: req.clientIp };
}
