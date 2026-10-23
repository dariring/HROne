import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './paths.ts';

let key: Buffer | null = null;

function getKey(): Buffer {
  if (key) return key;
  if (fs.existsSync(PATHS.secretKey)) {
    key = Buffer.from(fs.readFileSync(PATHS.secretKey, 'utf8').trim(), 'base64');
  } else {
    fs.mkdirSync(path.dirname(PATHS.secretKey), { recursive: true });
    key = crypto.randomBytes(32);
    fs.writeFileSync(PATHS.secretKey, key.toString('base64') + '\n', { mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('secret.key 가 손상되었습니다');
  return key;
}

/** AES-256-GCM. 빈 문자열은 그대로 둔다. */
export function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(enc: string | null | undefined): string {
  if (!enc) return '';
  const [v, iv, tag, ct] = enc.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('암호화 데이터 형식 오류');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJSON(v: unknown) {
  return encrypt(JSON.stringify(v));
}

export function decryptJSON<T>(enc: string | null | undefined, fallback: T): T {
  if (!enc) return fallback;
  try {
    return JSON.parse(decrypt(enc)) as T;
  } catch {
    return fallback;
  }
}

// ---------- 비밀번호 ----------

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split(':');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** 헷갈리는 문자(0/O, 1/l/I)를 뺀 영숫자 비밀번호 */
export function randomPassword(len = 24) {
  const out: string[] = [];
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 256 - (256 % PW_CHARS.length)) out.push(PW_CHARS[b % PW_CHARS.length]!);
      if (out.length >= len) break;
    }
  }
  return out.join('');
}

// ---------- TOTP (RFC 6238) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) throw new Error('잘못된 base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secret: string, time = Date.now(), step = 30) {
  const counter = Math.floor(time / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export function verifyTotp(secret: string, code: string, window = 1) {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Date.now();
  for (let w = -window; w <= window; w++) {
    const expected = totpCode(secret, now + w * 30_000);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}
