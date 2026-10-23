import { ArrowDownUp, Boxes, Cpu, Database, ExternalLink, GitCommitHorizontal, HardDrive, MemoryStick, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AreaChart, Sparkline } from '../components/Charts';
import { AppPower, DeployBadge, PendingDeploy, TRIGGER, type Deploy } from '../components/shared';
import { Button, Card, Empty, Loading, Meter, StatusBadge, StatusDot, cx } from '../components/ui';
import { ago, bytes, duration, pct, rate, sha } from '../lib/format';
import { Link, navigate, useTitle } from '../lib/router';
import { useApi, useLive, type SystemNow, type UnitStatus } from '../lib/store';

export interface AppSummary {
  id: number;
  slug: string;
  name: string;
  runtime: 'node' | 'python';
  runtimeVersion: string;
  repoUrl: string;
  repoWeb: string;
  branch: string;
  port: number | null;
  publicUrl: string;
  deployMode: 'auto' | 'delay' | 'manual';
  deployDelaySec: number;
  autostart: boolean;
  desiredState: 'running' | 'stopped';
  deployedSha: string | null;
  deployedAt: number | null;
  lastPollAt: number | null;
  lastPollError: string | null;
  status: UnitStatus | null;
  openDeploy: { id: number; status: string; to_sha: string | null; scheduled_at: number | null } | null;
  lastDeploy: { id: number; status: string; finished_at: number | null } | null;
  busy: boolean;
}

export interface DbSummary {
  id: number;
  slug: string;
  name: string;
  type: 'mariadb' | 'redis';
  port: number;
  bind: string;
  autostart: boolean;
  initialized: boolean;
  desiredState: string;
  status: UnitStatus | null;
  job: { id: number; kind: string; title: string } | null;
  linkedApps: { slug: string; name: string; prefix: string }[];
}

interface Sample {
  t: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
}

export function RuntimeIcon({ runtime, size = 34 }: { runtime: 'node' | 'python'; size?: number }) {
  return (
    <div
      className={cx('flex shrink-0 items-center justify-center rounded-[10px] text-[11px] font-black', runtime === 'node' ? 'bg-[#3c873a]/20 text-[#7fd17c]' : 'bg-[#3776ab]/25 text-[#8ab9e8]')}
      style={{ width: size, height: size }}
    >
      {runtime === 'node' ? 'JS' : 'PY'}
    </div>
  );
}

export function DbIcon({ type, size = 34 }: { type: 'mariadb' | 'redis'; size?: number }) {
  return (
    <div className={cx('flex shrink-0 items-center justify-center rounded-[10px]', type === 'mariadb' ? 'bg-[#c0765a]/20 text-[#e9a68a]' : 'bg-[#d82c20]/20 text-[#f0857c]')} style={{ width: size, height: size }}>
      <Database size={size * 0.5} />
    </div>
  );
}

function useHistory() {
  const live = useLive();
  const { data } = useApi<{ history: Sample[] }>('/api/system/metrics?range=1h');
  const [hist, setHist] = useState<Sample[]>([]);
  useEffect(() => {
    if (data) setHist(data.history.slice(-900));
  }, [data]);
  useEffect(() => {
    const s = live.system;
    if (!s) return;
    setHist((h) => (h.length && h[h.length - 1]!.t >= s.t ? h : [...h.slice(-899), { t: s.t, cpu: s.cpu, mem: s.mem, rx: s.rx, tx: s.tx }]));
  }, [live.system]);
  return hist;
}

function StatCard({ icon, label, value, sub, percent, spark, sparkMax, color }: { icon: React.ReactNode; label: string; value: string; sub?: string; percent?: number; spark?: number[]; sparkMax?: number; color?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
      {percent !== undefined && (
        <div className="mt-3">
          <Meter value={percent} />
        </div>
      )}
      {spark && (
        <div className="mt-2">
          <Sparkline values={spark} max={sparkMax} color={color} height={30} />
        </div>
      )}
    </div>
  );
}

export function SystemCards({ sys, hist }: { sys: SystemNow | null; hist: Sample[] }) {
  if (!sys) return <Loading text="시스템 정보 수집 중..." />;
  const disk = sys.disk[0];
  const recent = hist.slice(-90);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard icon={<Cpu size={14} />} label="CPU" value={pct(sys.cpu)} sub={`${sys.cores.length}코어 · 부하 ${sys.load.toFixed(2)}`} spark={recent.map((s) => s.cpu)} sparkMax={100} />
      <StatCard icon={<MemoryStick size={14} />} label="메모리" value={pct(sys.mem)} sub={`${bytes(sys.memUsed)} / ${bytes(sys.memTotal)}${sys.swapTotal ? ` · 스왑 ${bytes(sys.swapUsed)}` : ''}`} spark={recent.map((s) => s.mem)} sparkMax={100} color="var(--color-info)" />
      <StatCard icon={<HardDrive size={14} />} label="디스크" value={disk ? pct((disk.used / disk.total) * 100) : '-'} sub={disk ? `${bytes(disk.used)} / ${bytes(disk.total)}` : ''} percent={disk ? (disk.used / disk.total) * 100 : 0} />
      <StatCard icon={<ArrowDownUp size={14} />} label="네트워크" value={`↓ ${rate(sys.rx)}`} sub={`↑ ${rate(sys.tx)} · 가동 ${duration(sys.uptime)}`} spark={recent.map((s) => s.rx + s.tx)} color="var(--color-ok)" />
    </div>
  );
}

export function Dashboard() {
  useTitle('대시보드');
  const live = useLive();
  const hist = useHistory();
  const { data, loading } = useApi<{ apps: AppSummary[]; databases: DbSummary[]; open: Deploy[]; recent: Deploy[]; system: SystemNow | null }>('/api/dashboard', {
    refreshOn: ['apps', 'deploys', 'databases'],
  });
  const appsById = useMemo(() => new Map((data?.apps ?? []).map((a) => [a.id, a])), [data]);
  const waiting = (data?.open ?? []).filter((d) => d.status === 'pending' || d.status === 'scheduled');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">대시보드</h1>
        <div className="flex gap-2">
          <Button icon={<Database size={15} />} onClick={() => navigate('/databases?new=1')}>
            DB 추가
          </Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/apps/new')}>
            앱 추가
          </Button>
        </div>
      </div>

      <SystemCards sys={live.system ?? data?.system ?? null} hist={hist} />

      {waiting.length > 0 && (
        <Card title={<span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-warn pulse" />적용 대기 중인 배포</span>} pad={false}>
          <div className="divide-y divide-line">
            {waiting.map((d) => (
              <div key={d.id} className="px-5 py-3">
                <PendingDeploy d={{ ...d, appName: appsById.get(d.app_id)?.name }} />
              </div>
            ))}
          </div>
        </Card>
      )}

      {loading && !data ? (
        <Loading />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="space-y-6">
            <Card title={<span className="flex items-center gap-2"><Boxes size={16} /> 앱</span>} actions={<Link to="/apps" className="text-xs text-muted hover:text-fg">전체 보기</Link>} pad={false}>
              {data!.apps.length === 0 ? (
                <Empty icon={<Boxes size={24} />} title="아직 앱이 없습니다" action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/apps/new')}>첫 앱 추가</Button>}>
                  GitHub 저장소를 연결하면 푸시할 때마다 자동으로 배포됩니다.
                </Empty>
              ) : (
                <div className="divide-y divide-line">
                  {data!.apps.map((a) => {
                    const st = live.units[`hrone-app-${a.slug}.service`] ?? a.status;
                    return (
                      <div key={a.slug} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                        <Link to={`/apps/${a.slug}`} className="flex min-w-0 flex-1 items-center gap-3">
                          <RuntimeIcon runtime={a.runtime} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-semibold">{a.name}</span>
                              <StatusBadge state={a.deployedSha ? st?.state : 'not-deployed'} />
                            </div>
                            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                              <span className="mono">127.0.0.1:{a.port}</span>
                              <span>
                                {a.branch} · {sha(a.deployedSha)}
                              </span>
                              {st?.state === 'running' && (
                                <span>
                                  CPU {pct(st.cpu, 1)} · {bytes(st.memory)}
                                </span>
                              )}
                            </div>
                          </div>
                        </Link>
                        {a.publicUrl && (
                          <a href={a.publicUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-fg" title={a.publicUrl}>
                            <ExternalLink size={15} />
                          </a>
                        )}
                        <AppPower slug={a.slug} state={st?.state} deployed={!!a.deployedSha} />
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title={<span className="flex items-center gap-2"><Cpu size={16} /> 최근 1시간</span>}>
              <AreaChart
                times={hist.map((h) => h.t)}
                max={100}
                format={(v) => `${v.toFixed(0)}%`}
                series={[
                  { label: 'CPU', color: 'var(--color-accent)', values: hist.map((h) => h.cpu) },
                  { label: '메모리', color: 'var(--color-info)', values: hist.map((h) => h.mem) },
                ]}
              />
            </Card>
          </div>

          <div className="space-y-6">
            <Card title={<span className="flex items-center gap-2"><Database size={16} /> 데이터베이스</span>} actions={<Link to="/databases" className="text-xs text-muted hover:text-fg">전체 보기</Link>} pad={false}>
              {data!.databases.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted">MariaDB / Redis 인스턴스를 추가할 수 있습니다</div>
              ) : (
                <div className="divide-y divide-line">
                  {data!.databases.map((d) => {
                    const st = live.units[`hrone-db-${d.slug}.service`] ?? d.status;
                    return (
                      <Link key={d.slug} to={`/databases/${d.slug}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                        <DbIcon type={d.type} size={30} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{d.name}</div>
                          <div className="text-xs text-muted">
                            {d.type === 'mariadb' ? 'MariaDB' : 'Redis'} · :{d.port} {st?.state === 'running' && `· ${bytes(st.memory)}`}
                          </div>
                        </div>
                        {d.job ? <span className="text-xs text-info">준비 중...</span> : <StatusDot state={d.initialized ? st?.state : 'not-deployed'} />}
                      </Link>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title={<span className="flex items-center gap-2"><GitCommitHorizontal size={16} /> 최근 배포</span>} pad={false}>
              {data!.recent.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted">배포 기록이 없습니다</div>
              ) : (
                <div className="divide-y divide-line">
                  {data!.recent.map((d) => (
                    <Link key={d.id} to={`/apps/${d.appSlug}?tab=deploys&deploy=${d.id}`} className="block px-5 py-2.5 hover:bg-surface-2/60">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{d.appName}</span>
                        <DeployBadge status={d.status} />
                      </div>
                      <div className="mt-0.5 flex justify-between gap-2 text-xs text-muted">
                        <span className="truncate">
                          <span className="mono">{sha(d.to_sha)}</span> {d.commits[0]?.message ?? TRIGGER[d.trigger]}
                        </span>
                        <span className="shrink-0">{ago(d.finished_at ?? d.created_at)}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
