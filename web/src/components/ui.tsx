import { Check, ChevronDown, Copy, Eye, EyeOff, Loader2, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { RunState } from '../lib/store';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

// ---------- Button ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warn';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-2 border-transparent',
  secondary: 'bg-fill text-fg hover:bg-fill-strong/50 border-transparent',
  ghost: 'bg-transparent text-fg-2 hover:bg-surface-3 hover:text-fg border-transparent',
  danger: 'bg-bad/15 text-bad hover:bg-bad/25 border-bad/30',
  success: 'bg-ok/15 text-ok hover:bg-ok/25 border-ok/30',
  warn: 'bg-warn/15 text-warn hover:bg-warn/25 border-warn/30',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[9px] border font-medium transition-colors select-none whitespace-nowrap',
        'disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : size === 'lg' ? 'h-11 px-5 text-[15px]' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ title, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cx('inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg transition-colors cursor-pointer disabled:opacity-40', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- 레이아웃 ----------

export function Card({ children, className, title, actions, pad = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; pad?: boolean }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h3 className="text-[15px] font-semibold">{title}</h3>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, sub, actions, icon }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon && <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-accent-2">{icon}</div>}
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
          {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** 접었다 펼 수 있는 카드. 닫혀 있을 때는 제목과 한 줄 요약만 보인다 */
export function Fold({
  icon,
  title,
  summary,
  children,
  defaultOpen = false,
  danger,
}: {
  icon?: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cx('card overflow-hidden', danger && 'border-bad/30')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface-2/60 cursor-pointer"
      >
        {icon && <span className={cx('shrink-0', danger ? 'text-bad' : 'text-accent-2')}>{icon}</span>}
        <span className="min-w-0 flex-1">
          <span className={cx('block text-[15px] font-semibold', danger && 'text-bad')}>{title}</span>
          {summary && !open && <span className="mt-0.5 block truncate text-xs text-muted">{summary}</span>}
        </span>
        <ChevronDown size={18} className={cx('shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-4 border-t border-line p-5">{children}</div>}
    </section>
  );
}

/** 폼 안에서 "고급 설정" 같은 부분을 접어 두는 버튼 */
export function Disclosure({ label, children, defaultOpen = false }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-2 hover:text-fg cursor-pointer">
        <ChevronDown size={16} className={cx('transition-transform', !open && '-rotate-90')} />
        {label}
      </button>
      {open && <div className="mt-4 space-y-4">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label, sub }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; sub?: ReactNode }) {
  return (
    <label className={cx('flex items-start gap-3', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors cursor-pointer', checked ? 'bg-ok' : 'bg-fill-strong/60')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {(label || sub) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium">{label}</span>}
          {sub && <span className="block text-xs text-muted mt-0.5 leading-relaxed">{sub}</span>}
        </span>
      )}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-[9px] bg-fill p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors cursor-pointer',
            value === o.value ? 'bg-fill-strong text-fg shadow-sm' : 'text-fg-2 hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; badge?: ReactNode }[] }) {
  return (
    <div className="mb-5 flex gap-0.5 overflow-x-auto border-b border-line [scrollbar-width:none] sm:gap-1">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cx(
            'flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-sm font-medium transition-colors cursor-pointer sm:px-3.5',
            value === t.value ? 'tab-active' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

// ---------- 표시 ----------

type Tone = 'gray' | 'green' | 'red' | 'yellow' | 'blue' | 'purple';
const TONES: Record<Tone, string> = {
  gray: 'bg-surface-3 text-fg-2 border-line-2',
  green: 'bg-ok/12 text-ok border-ok/25',
  red: 'bg-bad/12 text-bad border-bad/25',
  yellow: 'bg-warn/12 text-warn border-warn/25',
  blue: 'bg-info/12 text-info border-info/25',
  purple: 'bg-accent/15 text-accent-2 border-accent/30',
};

export function Badge({ tone = 'gray', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

const STATE: Record<RunState, { label: string; dot: string; tone: Tone; pulse?: boolean }> = {
  running: { label: '실행 중', dot: 'bg-ok', tone: 'green' },
  starting: { label: '시작 중', dot: 'bg-info', tone: 'blue', pulse: true },
  restarting: { label: '재시작 대기', dot: 'bg-warn', tone: 'yellow', pulse: true },
  stopping: { label: '정지 중', dot: 'bg-warn', tone: 'yellow', pulse: true },
  stopped: { label: '정지됨', dot: 'bg-muted', tone: 'gray' },
  failed: { label: '실패', dot: 'bg-bad', tone: 'red' },
  'not-deployed': { label: '배포 전', dot: 'bg-muted', tone: 'gray' },
  unknown: { label: '알 수 없음', dot: 'bg-muted', tone: 'gray' },
};

export function StatusDot({ state }: { state: RunState | null | undefined }) {
  const s = STATE[state ?? 'not-deployed'];
  return <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', s.dot, s.pulse && 'pulse')} />;
}

export function StatusBadge({ state }: { state: RunState | null | undefined }) {
  const s = STATE[state ?? 'not-deployed'];
  return (
    <Badge tone={s.tone}>
      <StatusDot state={state} />
      {s.label}
    </Badge>
  );
}

export function stateLabel(state: RunState | null | undefined) {
  return STATE[state ?? 'not-deployed'].label;
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('spin text-muted', className)} />;
}

export function Loading({ text = '불러오는 중...' }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner />
      {text}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">
      <span className="whitespace-pre-wrap break-words">{error}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'blue', title, children, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={cx('flex gap-3 rounded-xl border px-4 py-3 text-sm', TONES[tone])}>
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0 leading-relaxed">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5' : '', 'text-fg-2')}>{children}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-3 text-muted">{icon}</div>}
      <div className="text-base font-semibold">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-sm text-muted leading-relaxed">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Meter({ value, tone }: { value: number; tone?: 'auto' | Tone }) {
  const v = Math.max(0, Math.min(100, value));
  const color = tone && tone !== 'auto' ? { gray: 'bg-muted', green: 'bg-ok', red: 'bg-bad', yellow: 'bg-warn', blue: 'bg-info', purple: 'bg-accent' }[tone] : v > 90 ? 'bg-bad' : v > 75 ? 'bg-warn' : 'bg-accent';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={cx('h-full rounded-full transition-all duration-500', color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(90px,auto)_1fr] gap-x-5 gap-y-2.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------- 복사 / 비밀값 ----------

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, []);
  return { copied, copy };
}

export function CopyButton({ text, title = '복사' }: { text: string; title?: string }) {
  const { copied, copy } = useCopy();
  return (
    <IconButton title={copied ? '복사됨' : title} onClick={() => copy(text)}>
      {copied ? <Check size={15} className="text-ok" /> : <Copy size={15} />}
    </IconButton>
  );
}

export function CopyField({ value, secret, mono = true, onReveal }: { value: string; secret?: boolean; mono?: boolean; onReveal?: () => Promise<string> }) {
  const [shown, setShown] = useState(!secret);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  return (
    <div className="flex items-center gap-1 rounded-[9px] bg-fill pl-3 pr-1">
      <div className={cx('min-w-0 flex-1 truncate py-2 text-[13px]', mono && 'mono')}>{shown ? val : '•'.repeat(Math.min(24, Math.max(8, val.length)))}</div>
      {secret && (
        <IconButton
          title={shown ? '숨기기' : '보기'}
          onClick={async () => {
            if (!shown && onReveal) setVal(await onReveal());
            setShown(!shown);
          }}
        >
          {shown ? <EyeOff size={15} /> : <Eye size={15} />}
        </IconButton>
      )}
      <CopyButton text={val} />
    </div>
  );
}

// ---------- 모달 ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  dismissable?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismissable && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, dismissable, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div className="card toast-in flex max-h-[92vh] w-full flex-col overflow-hidden rounded-b-none shadow-2xl sm:rounded-[14px]" style={{ maxWidth: width }}>
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h3 className="text-base font-semibold">{title}</h3>
          {dismissable && (
            <IconButton title="닫기" onClick={onClose}>
              <X size={17} />
            </IconButton>
          )}
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- 확인창 ----------

interface ConfirmOpts {
  title: ReactNode;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
}

const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

export function ConfirmHost({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => {
    setOpts(o);
    return new Promise<boolean>((r) => (resolver.current = r));
  }, []);
  const done = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal
        open={!!opts}
        onClose={() => done(false)}
        title={opts?.title}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => done(false)}>
              취소
            </Button>
            <Button variant={opts?.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
              {opts?.confirm ?? '확인'}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-relaxed text-fg-2">{opts?.body}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmCtx);

// ---------- 토스트 ----------

interface ToastItem {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}

let toastSeq = 0;
const toastListeners = new Set<(t: ToastItem) => void>();

export const toast = {
  ok: (text: string) => toastListeners.forEach((l) => l({ id: ++toastSeq, tone: 'ok', text })),
  error: (text: string) => toastListeners.forEach((l) => l({ id: ++toastSeq, tone: 'bad', text })),
  info: (text: string) => toastListeners.forEach((l) => l({ id: ++toastSeq, tone: 'info', text })),
};

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const l = (t: ToastItem) => {
      setItems((x) => [...x.slice(-4), t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), t.tone === 'bad' ? 7000 : 3500);
    };
    toastListeners.add(l);
    return () => {
      toastListeners.delete(l);
    };
  }, []);
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 left-4 z-[60] flex flex-col items-end gap-2 sm:left-auto">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            'toast-in pointer-events-auto max-w-sm rounded-xl border px-4 py-2.5 text-sm shadow-xl backdrop-blur',
            t.tone === 'ok' ? 'border-ok/30 bg-[#0f231c]/95 text-ok' : t.tone === 'bad' ? 'border-bad/30 bg-[#2a1215]/95 text-bad' : 'border-line-2 bg-surface-2/95 text-fg',
          )}
        >
          <span className="whitespace-pre-wrap break-words">{t.text}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** 비동기 작업 버튼 공통: 로딩 상태 + 실패 토스트 */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>, okText?: string) => {
    setBusy(key);
    try {
      await fn();
      if (okText) toast.ok(okText);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}
