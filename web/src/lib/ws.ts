type Handler = (data: any) => void;

/** 하나의 WebSocket 으로 여러 채널 구독. 끊기면 자동 재연결 후 다시 구독한다. */
class Socket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 0;
  private timer: number | null = null;
  private stateListeners = new Set<(up: boolean) => void>();
  up = false;

  private url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/ws`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setUp(true);
      for (const ch of this.handlers.keys()) ws.send(JSON.stringify({ op: 'sub', ch }));
    };
    ws.onmessage = (ev) => {
      try {
        const { ch, data } = JSON.parse(ev.data as string);
        this.handlers.get(ch)?.forEach((h) => h(data));
      } catch {
        /* noop */
      }
    };
    ws.onclose = () => {
      this.setUp(false);
      this.ws = null;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      if (this.timer) clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private setUp(v: boolean) {
    this.up = v;
    this.stateListeners.forEach((l) => l(v));
  }

  onState(l: (up: boolean) => void) {
    this.stateListeners.add(l);
    return () => {
      this.stateListeners.delete(l);
    };
  }

  subscribe(ch: string, h: Handler) {
    let set = this.handlers.get(ch);
    if (!set) {
      set = new Set();
      this.handlers.set(ch, set);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 'sub', ch }));
    }
    set.add(h);
    this.connect();
    return () => {
      const s = this.handlers.get(ch);
      if (!s) return;
      s.delete(h);
      if (!s.size) {
        this.handlers.delete(ch);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op: 'unsub', ch }));
      }
    };
  }
}

export const socket = new Socket();
