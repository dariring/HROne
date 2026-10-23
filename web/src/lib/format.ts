export function bytes(n: number | null | undefined, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  if (n < 1024) return `${Math.round(n)} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${u[i]}`;
}

export function rate(n: number | null | undefined) {
  return n === null || n === undefined ? '-' : `${bytes(n)}/s`;
}

export function pct(n: number | null | undefined, digits = 0) {
  return n === null || n === undefined ? '-' : `${n.toFixed(digits)}%`;
}

export function duration(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  if (sec < 60) return `${Math.floor(sec)}초`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  const d = Math.floor(h / 24);
  return `${d}일 ${h % 24}시간`;
}

export function ago(ts: number | null | undefined) {
  if (!ts) return '-';
  const s = (Date.now() - ts) / 1000;
  if (s < 0) return `${duration(-s)} 후`;
  if (s < 10) return '방금';
  if (s < 60) return `${Math.floor(s)}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return dateTime(ts);
}

export function dateTime(ts: number | null | undefined) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function timeOnly(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const sha = (s: string | null | undefined) => (s ? s.slice(0, 7) : '-');

export function delayText(sec: number) {
  if (sec < 60) return `${sec}초`;
  if (sec < 3600) return `${Math.round(sec / 60)}분`;
  return `${Math.round((sec / 3600) * 10) / 10}시간`;
}
