/** ANSI SGR 색 코드를 스타일 조각으로 나눈다 (로그 콘솔용) */
export interface Seg {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

const BASE = ['#3b3f4a', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc', '#22d3ee', '#d4d7de'];
const BRIGHT = ['#6b7280', '#fca5a5', '#86efac', '#fde047', '#93c5fd', '#d8b4fe', '#67e8f9', '#ffffff'];

function c256(n: number) {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const v = [0, 95, 135, 175, 215, 255];
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// eslint-disable-next-line no-control-regex
const RE = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const OTHER = /\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b\][^\x07]*\x07|\r/g;

export function parseAnsi(input: string): Seg[] {
  const s = input.replace(OTHER, '');
  const out: Seg[] = [];
  let cur: Omit<Seg, 'text'> = {};
  let last = 0;
  let m: RegExpExecArray | null;
  RE.lastIndex = 0;
  while ((m = RE.exec(s))) {
    if (m.index > last) out.push({ ...cur, text: s.slice(last, m.index) });
    last = RE.lastIndex;
    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) cur = {};
      else if (c === 1) cur.bold = true;
      else if (c === 2) cur.dim = true;
      else if (c === 4) cur.underline = true;
      else if (c === 22) {
        cur.bold = false;
        cur.dim = false;
      } else if (c === 24) cur.underline = false;
      else if (c >= 30 && c <= 37) cur.fg = BASE[c - 30];
      else if (c >= 90 && c <= 97) cur.fg = BRIGHT[c - 90];
      else if (c === 39) cur.fg = undefined;
      else if (c >= 40 && c <= 47) cur.bg = BASE[c - 40];
      else if (c >= 100 && c <= 107) cur.bg = BRIGHT[c - 100];
      else if (c === 49) cur.bg = undefined;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = c256(codes[i + 2] ?? 0);
        if (c === 38) cur.fg = col;
        else cur.bg = col;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (c === 38) cur.fg = col;
        else cur.bg = col;
        i += 4;
      }
    }
  }
  if (last < s.length) out.push({ ...cur, text: s.slice(last) });
  return out;
}

export function stripAnsi(s: string) {
  return s.replace(RE, '').replace(OTHER, '');
}
