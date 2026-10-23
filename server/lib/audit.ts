import { q } from './db.ts';

export interface Actor {
  username: string;
  ip: string;
}

export const SYSTEM: Actor = { username: 'system', ip: '' };

export function audit(actor: Actor | null, action: string, target = '', detail: unknown = '') {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  q.run(
    'INSERT INTO audit (ts, username, ip, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
    Date.now(),
    actor?.username ?? 'system',
    actor?.ip ?? '',
    action,
    target,
    d,
  );
  // 오래된 기록 정리 (최근 20000건 유지)
  if (Math.random() < 0.01) {
    q.run('DELETE FROM audit WHERE id < (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 20000)');
  }
}
