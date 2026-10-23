import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { socket } from './ws';

export type RunState = 'running' | 'starting' | 'restarting' | 'stopping' | 'stopped' | 'failed' | 'not-deployed' | 'unknown';

export interface UnitStatus {
  unit: string;
  state: RunState;
  activeState: string;
  subState: string;
  pid: number;
  restarts: number;
  memory: number | null;
  cpu: number | null;
  tasks: number | null;
  since: number | null;
  enabled: boolean;
  exitStatus: number | null;
  result: string;
  listen: { addr: string; port: number }[];
}

export interface SystemNow {
  t: number;
  cpu: number;
  mem: number;
  memUsed: number;
  memTotal: number;
  swapTotal: number;
  swapUsed: number;
  rx: number;
  tx: number;
  load: number;
  cores: number[];
  disk: { mount: string; total: number; used: number }[];
  uptime: number;
}

/** 'status' 채널을 한 번만 구독해 전역으로 나눠 쓴다 */
let state: { units: Record<string, UnitStatus>; system: SystemNow | null } = { units: {}, system: null };
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  socket.subscribe('status', (data) => {
    state = data;
    listeners.forEach((l) => l());
  });
}

export function useLive() {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function useUnit(unit: string): UnitStatus | null {
  return useLive().units[unit] ?? null;
}

export function useChannel(ch: string | null, cb: (data: any) => void) {
  // 콜백은 매 렌더마다 바뀌어도 구독은 채널이 바뀔 때만 다시 한다
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!ch) return;
    return socket.subscribe(ch, (d) => ref.current(d));
  }, [ch]);
}

export function useSocketUp() {
  const [up, setUp] = useState(socket.up);
  useEffect(() => {
    // 렌더와 effect 사이에 연결이 열렸을 수 있으니 현재 값으로 맞춘다
    setUp(socket.up);
    return socket.onState(setUp);
  }, []);
  return up;
}

/** GET 요청 + 수동 새로고침 + (선택) 채널 이벤트에 맞춰 자동 새로고침 */
export function useApi<T>(path: string | null, opts: { refreshOn?: string[]; interval?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api
      .get<T>(path)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  useEffect(() => {
    if (!opts.interval) return;
    const t = setInterval(() => setTick((x) => x + 1), opts.interval);
    return () => clearInterval(t);
  }, [opts.interval]);
  useEffect(() => {
    if (!opts.refreshOn?.length) return;
    let pending: number | null = null;
    const bump = () => {
      if (pending) return;
      pending = window.setTimeout(() => {
        pending = null;
        setTick((x) => x + 1);
      }, 250);
    };
    const offs = opts.refreshOn.map((ch) => socket.subscribe(ch, bump));
    return () => {
      offs.forEach((o) => o());
      if (pending) clearTimeout(pending);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.refreshOn?.join(',')]);
  return { data, error, loading, reload: () => setTick((x) => x + 1), setData };
}
