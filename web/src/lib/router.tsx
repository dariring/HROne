import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const snapshot = () => location.pathname + location.search;

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === snapshot()) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.scrollTo(0, 0);
  notify();
}

export function useLocation() {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const [path, qs = ''] = loc.split('?');
  return { path: path!, query: new URLSearchParams(qs) };
}

/** '/apps/:slug' 패턴 매칭 */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function setQuery(key: string, value: string | null) {
  const q = new URLSearchParams(location.search);
  if (value === null) q.delete(key);
  else q.set(key, value);
  const qs = q.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
  notify();
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · HROne` : 'HROne';
  }, [title]);
}
