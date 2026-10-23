import { useMemo, useRef, useState } from 'react';
import { timeOnly } from '../lib/format';

export function Sparkline({ values, max, color = 'var(--color-accent)', height = 32 }: { values: number[]; max?: number; color?: string; height?: number }) {
  const w = 120;
  const path = useMemo(() => {
    if (values.length < 2) return '';
    const m = max ?? Math.max(1, ...values);
    return values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (values.length - 1)) * w).toFixed(1)},${(height - (Math.min(v, m) / m) * (height - 2) - 1).toFixed(1)}`)
      .join(' ');
  }, [values, max, height]);
  if (!path) return <div style={{ height }} />;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <path d={`${path} L${w},${height} L0,${height} Z`} fill={color} opacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface Series {
  label: string;
  color: string;
  values: number[];
  format?: (v: number) => string;
}

/** 시간축 영역 차트 (마우스를 올리면 값 표시) */
export function AreaChart({ times, series, max, height = 180, format }: { times: number[]; series: Series[]; max?: number; height?: number; format: (v: number) => string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = height;
  const n = times.length;
  const m = useMemo(() => max ?? Math.max(1, ...series.flatMap((s) => s.values)) * 1.1, [max, series]);
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - (Math.min(v, m) / m) * (H - 8) - 2;
  if (n < 2) return <div className="flex items-center justify-center text-xs text-muted" style={{ height }}>데이터 모으는 중...</div>;
  const ticks = [0, 0.5, 1].map((f) => m * f);
  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full overflow-visible"
        style={{ height }}
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <line key={i} x1={0} x2={W} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeDasharray={i === 0 ? '' : '3 4'} vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s) => {
          const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
          return (
            <g key={s.label}>
              <path d={`${d} L${W},${H} L0,${H} Z`} fill={s.color} opacity={0.1} />
              <path d={d} fill="none" stroke={s.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--color-muted)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="pointer-events-none absolute right-0 top-0 text-[10.5px] text-muted">{format(ticks[2]!)}</div>
      <div className="mt-1.5 flex justify-between text-[10.5px] text-muted">
        <span>{timeOnly(times[0]!)}</span>
        <span>{timeOnly(times[n - 1]!)}</span>
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute top-2 rounded-lg border border-line-2 bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-lg" style={{ left: `min(calc(${(hover / (n - 1)) * 100}% + 8px), calc(100% - 140px))` }}>
          <div className="mb-0.5 text-muted">{timeOnly(times[hover]!)}</div>
          {series.map((s) => (
            <div key={s.label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label} <b className="ml-auto pl-2">{(s.format ?? format)(s.values[hover] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
