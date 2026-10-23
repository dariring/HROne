import { Activity, Archive, Boxes, Database, Gauge, LogOut, Menu, Server, Settings, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { pct } from '../lib/format';
import { Link, useLocation } from '../lib/router';
import { useApi, useLive, useSocketUp } from '../lib/store';
import { cx } from './ui';

const NAV = [
  { to: '/', label: '대시보드', icon: Gauge, exact: true },
  { to: '/apps', label: '앱', icon: Boxes },
  { to: '/databases', label: '데이터베이스', icon: Database },
  { to: '/backups', label: '백업', icon: Archive },
  { to: '/system', label: '시스템', icon: Server },
  { to: '/settings', label: '설정', icon: Settings },
  { to: '/audit', label: '활동 기록', icon: Activity },
];

export interface Me {
  username: string;
  totpEnabled: boolean;
}

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  const live = useLive();
  const up = useSocketUp();
  const { data: open_ } = useApi<{ status: string }[]>('/api/deploys/open', { refreshOn: ['deploys'] });
  const pending = (open_ ?? []).filter((d) => d.status === 'pending').length;
  const { data: info } = useApi<{ hostname: string; virtualization: string }>('/api/system/info');

  useEffect(() => setOpen(false), [path]);

  const sys = live.system;
  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const active = n.exact ? path === n.to : path === n.to || path.startsWith(n.to + '/');
        const Icon = n.icon;
        return (
          <Link
            key={n.to}
            to={n.to}
            className={cx(
              'flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <Icon size={17} className={active ? 'text-accent-2' : ''} />
            {n.label}
            {n.to === '/apps' && pending > 0 && <span className="ml-auto rounded-full bg-warn px-1.5 text-[11px] font-bold text-black">{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );

  const side = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link to="/" className="flex items-center gap-2.5 px-2 pt-1">
        <img src="/favicon.svg" className="h-8 w-8" alt="" />
        <div>
          <div className="text-[17px] font-bold tracking-tight">HROne</div>
          <div className="-mt-0.5 max-w-[150px] truncate text-[11px] text-muted">{info?.hostname ?? ''}</div>
        </div>
      </Link>
      {nav}
      <div className="mt-auto space-y-3">
        {sys && (
          <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3 text-xs">
            {[
              ['CPU', sys.cpu],
              ['메모리', sys.mem],
              ['디스크', sys.disk[0] ? (sys.disk[0].used / sys.disk[0].total) * 100 : 0],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div className="mb-1 flex justify-between text-muted">
                  <span>{k}</span>
                  <span className="text-fg-2">{pct(v as number)}</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-surface-3">
                  <div className={cx('h-full rounded-full', (v as number) > 90 ? 'bg-bad' : (v as number) > 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, v as number)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent-2">{me.username.slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0">
              <div className="truncate font-medium">{me.username}</div>
              <div className="flex items-center gap-1 text-[11px] text-muted">
                <span className={cx('h-1.5 w-1.5 rounded-full', up ? 'bg-ok' : 'bg-bad pulse')} />
                {up ? '연결됨' : '재연결 중'}
                {me.totpEnabled && <ShieldCheck size={11} className="ml-1 text-ok" />}
              </div>
            </div>
          </div>
          <button
            type="button"
            title="로그아웃"
            className="rounded-lg p-1.5 text-muted hover:bg-surface-3 hover:text-fg cursor-pointer"
            onClick={async () => {
              await api.post('/api/auth/logout');
              location.href = '/';
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-line bg-surface lg:block">{side}</aside>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur lg:hidden">
        <Link to="/" className="flex items-center gap-2 font-bold">
          <img src="/favicon.svg" className="h-7 w-7" alt="" />
          HROne
        </Link>
        <button type="button" className="rounded-lg p-2 hover:bg-surface-3 cursor-pointer" onClick={() => setOpen(true)} aria-label="메뉴">
          <Menu size={20} />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface">
            <button type="button" className="absolute right-3 top-3 rounded-lg p-1.5 hover:bg-surface-3 cursor-pointer" onClick={() => setOpen(false)} aria-label="닫기">
              <X size={18} />
            </button>
            {side}
          </aside>
        </div>
      )}
      <main className="lg:pl-60">
        <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>
    </div>
  );
}
