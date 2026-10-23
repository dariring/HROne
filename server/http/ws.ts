import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { bus } from '../lib/events.ts';
import { UNIT } from '../lib/paths.ts';
import { SLUG_RE } from '../lib/util.ts';
import * as journal from '../services/journal.ts';

/**
 * 하나의 WebSocket 으로 여러 채널을 구독한다.
 *  client → { op: 'sub' | 'unsub', ch }
 *  server → { ch, data }
 * logs:app:<slug> / logs:db:<slug> 는 첫 구독자가 생길 때 journalctl -f 를 띄우고, 마지막 구독자가 나가면 끈다.
 */

const STATIC = new Set(['status', 'deploys', 'apps', 'databases', 'jobs', 'backups']);

function allowed(ch: string) {
  if (STATIC.has(ch)) return true;
  if (/^(deploy|job):\d+$/.test(ch)) return true;
  const m = ch.match(/^logs:(app|db):(.+)$/);
  return !!m && SLUG_RE.test(m[2]!);
}

const followers = new Map<string, { stop: () => void; subs: Set<WebSocket> }>();

function logUnit(ch: string) {
  const m = ch.match(/^logs:(app|db):(.+)$/)!;
  return m[1] === 'app' ? UNIT.app(m[2]!) : UNIT.db(m[2]!);
}

function subscribeLogs(ch: string, ws: WebSocket) {
  let f = followers.get(ch);
  if (!f) {
    const subs = new Set<WebSocket>();
    // 짧은 시간에 쏟아지는 줄은 묶어서 보낸다
    let buf: journal.LogEntry[] = [];
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      const msg = JSON.stringify({ ch, data: buf });
      buf = [];
      for (const s of subs) if (s.readyState === s.OPEN) s.send(msg);
    };
    const stop = journal.follow(logUnit(ch), (e) => {
      buf.push(e);
      if (buf.length > 2000) buf = buf.slice(-2000);
      if (!timer) timer = setTimeout(flush, 100);
    });
    f = { stop, subs };
    followers.set(ch, f);
  }
  f.subs.add(ws);
}

function unsubscribeLogs(ch: string, ws: WebSocket) {
  const f = followers.get(ch);
  if (!f) return;
  f.subs.delete(ws);
  if (!f.subs.size) {
    f.stop();
    followers.delete(ch);
  }
}

export function registerWs(server: FastifyInstance) {
  server.get('/api/ws', { websocket: true }, (socket) => {
    const subs = new Set<string>();
    const onBus = (ch: string, data: unknown) => {
      if (!subs.has(ch) || socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ ch, data }));
    };
    bus.on('message', onBus);
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);

    socket.on('message', (raw) => {
      let msg: { op?: string; ch?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const ch = String(msg.ch ?? '');
      if (!allowed(ch)) return;
      if (msg.op === 'sub' && !subs.has(ch)) {
        subs.add(ch);
        if (ch.startsWith('logs:')) subscribeLogs(ch, socket);
      } else if (msg.op === 'unsub' && subs.has(ch)) {
        subs.delete(ch);
        if (ch.startsWith('logs:')) unsubscribeLogs(ch, socket);
      }
    });

    socket.on('close', () => {
      clearInterval(ping);
      bus.off('message', onBus);
      for (const ch of subs) if (ch.startsWith('logs:')) unsubscribeLogs(ch, socket);
      subs.clear();
    });
  });
}
