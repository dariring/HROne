import { ArrowDown, Clock, Download, Eraser, Pause, Play, Search, WrapText } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { parseAnsi, stripAnsi } from '../lib/ansi';
import { timeOnly } from '../lib/format';
import { useChannel, useSocketUp } from '../lib/store';
import { cx, IconButton, toast, useConfirm } from './ui';

export interface LogEntry {
  t: number;
  m: string;
  s: 'a' | 's' | 'h';
  p: number;
}

const MAX = 5000;

const Line = memo(function Line({ e, showTime }: { e: LogEntry; showTime: boolean }) {
  const segs = useMemo(() => parseAnsi(e.m), [e.m]);
  const plainColor = e.s === 'h' ? 'text-accent-2' : e.s === 's' ? 'text-info/80' : e.p <= 3 ? 'text-bad' : e.p === 4 ? 'text-warn' : 'text-fg';
  return (
    <div className="log-line flex gap-3 px-3">
      {showTime && <span className="shrink-0 select-none text-muted/70">{timeOnly(e.t)}</span>}
      {e.s !== 'a' && <span className={cx('shrink-0 select-none', e.s === 'h' ? 'text-accent-2' : 'text-info/70')}>{e.s === 'h' ? 'HROne' : 'systemd'}</span>}
      <span className={cx('min-w-0', plainColor)}>
        {segs.map((s, i) =>
          s.fg || s.bg || s.bold || s.dim || s.underline ? (
            <span
              key={i}
              style={{ color: s.fg, background: s.bg, fontWeight: s.bold ? 700 : undefined, opacity: s.dim ? 0.65 : undefined, textDecoration: s.underline ? 'underline' : undefined }}
            >
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    </div>
  );
});

export function LogViewer({ kind, slug, height = 'calc(100vh - 300px)' }: { kind: 'app' | 'db'; slug: string; height?: string }) {
  const base = kind === 'app' ? `/api/apps/${slug}` : `/api/databases/${slug}`;
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('');
  const [showTime, setShowTime] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [systemLines, setSystemLines] = useState(true);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const pausedBuf = useRef<LogEntry[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const up = useSocketUp();

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    api
      .get<LogEntry[]>(`${base}/logs?lines=1500`)
      .then((d) => alive && setLines(d))
      .catch((e) => toast.error(e.message))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [base]);

  useChannel(`logs:${kind}:${slug}`, (batch: LogEntry[]) => {
    if (paused) {
      pausedBuf.current.push(...batch);
      return;
    }
    setLines((prev) => {
      const next = prev.concat(batch);
      return next.length > MAX ? next.slice(next.length - MAX) : next;
    });
  });

  useEffect(() => {
    if (!paused && pausedBuf.current.length) {
      const buf = pausedBuf.current;
      pausedBuf.current = [];
      setLines((prev) => prev.concat(buf).slice(-MAX));
    }
  }, [paused]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return lines.filter((l) => (systemLines || l.s === 'a') && (!f || stripAnsi(l.m).toLowerCase().includes(f)));
  }, [lines, filter, systemLines]);

  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <div className="card flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative min-w-[160px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input h-8 pl-8 text-[13px]" placeholder="로그 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted select-none">
          <input type="checkbox" checked={systemLines} onChange={(e) => setSystemLines(e.target.checked)} className="accent-[var(--color-accent)]" />
          시스템 메시지
        </label>
        <div className="flex items-center">
          <IconButton title={paused ? '이어서 받기' : '일시정지'} onClick={() => setPaused(!paused)} className={paused ? 'text-warn' : ''}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </IconButton>
          <IconButton title="시간 표시" onClick={() => setShowTime(!showTime)} className={showTime ? 'text-fg' : ''}>
            <Clock size={15} />
          </IconButton>
          <IconButton title="자동 줄바꿈" onClick={() => setWrap(!wrap)} className={wrap ? 'text-fg' : ''}>
            <WrapText size={15} />
          </IconButton>
          <a href={`${base}/logs/download`} title="전체 로그 내려받기" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg">
            <Download size={15} />
          </a>
          <IconButton
            title="화면 비우기"
            onClick={async () => {
              if (!(await confirm({ title: '콘솔 비우기', body: '지금까지의 로그를 화면에서 숨깁니다. (journald 원본은 남아 있어 내려받기로 볼 수 있습니다)', confirm: '비우기' }))) return;
              await api.post(`${base}/logs/clear`);
              setLines([]);
            }}
          >
            <Eraser size={15} />
          </IconButton>
        </div>
      </div>
      <div className="relative">
        <div
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (atBottom !== follow) setFollow(atBottom);
          }}
          className={cx('mono overflow-auto bg-code py-2 text-[12.5px] leading-[1.6]', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}
          style={{ height, minHeight: 280 }}
        >
          {!loaded ? (
            <div className="px-3 text-muted">불러오는 중...</div>
          ) : shown.length === 0 ? (
            <div className="px-3 text-muted">{filter ? '검색 결과가 없습니다' : '아직 출력이 없습니다'}</div>
          ) : (
            shown.map((e, i) => <Line key={`${e.t}-${i}`} e={e} showTime={showTime} />)
          )}
        </div>
        {!follow && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="absolute bottom-3 right-4 flex items-center gap-1 rounded-full border border-line-2 bg-surface-2 px-3 py-1.5 text-xs shadow-lg hover:bg-surface-3 cursor-pointer"
          >
            <ArrowDown size={13} /> 최신으로
          </button>
        )}
        <div className="absolute right-3 top-2 flex items-center gap-1.5 text-[11px] text-muted">
          <span className={cx('h-1.5 w-1.5 rounded-full', paused ? 'bg-warn' : up ? 'bg-ok pulse' : 'bg-bad')} />
          {paused ? `일시정지 (${pausedBuf.current.length}줄 대기)` : up ? '실시간' : '연결 끊김'}
        </div>
      </div>
    </div>
  );
}

/** 배포 로그: 텍스트 + 실시간 줄 추가 */
export function DeployLog({ id, running, height = 420 }: { id: number; running: boolean; height?: number }) {
  const [text, setText] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    let alive = true;
    api.get<{ log: string }>(`/api/deploys/${id}`).then((d) => alive && setText(d.log.split('\n')));
    return () => {
      alive = false;
    };
  }, [id, running]);
  useChannel(running ? `deploy:${id}` : null, (d: { line?: string }) => {
    if (d.line !== undefined) setText((t) => [...t, d.line!]);
  });
  useLayoutEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, follow]);
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      }}
      className="mono overflow-auto rounded-xl border border-line bg-code p-3 text-[12.5px] leading-[1.6] whitespace-pre-wrap break-all"
      style={{ height }}
    >
      {text.map((l, i) => {
        const tone = l.startsWith('✔') ? 'text-ok' : l.startsWith('✖') ? 'text-bad' : l.startsWith('↩') ? 'text-warn' : l.startsWith('━━') ? 'text-accent-2 font-semibold mt-1' : l.startsWith('$ ') ? 'text-info' : l.startsWith('▶') ? 'text-fg font-semibold' : 'text-fg-2';
        return (
          <div key={i} className={tone}>
            {parseAnsi(l).map((s, j) => (
              <span key={j} style={{ color: s.fg, fontWeight: s.bold ? 700 : undefined, opacity: s.dim ? 0.65 : undefined }}>
                {s.text}
              </span>
            ))}
            {l === '' && ' '}
          </div>
        );
      })}
      {running && <div className="pulse text-muted">▍</div>}
    </div>
  );
}
