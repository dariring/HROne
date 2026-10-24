import { ArrowDownUp, Boxes, Check, Cpu, Database, ExternalLink, GitCommitHorizontal, HardDrive, ListChecks, MemoryStick, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Sparkline } from '../components/Charts';
import type { Me } from '../components/Layout';
import { AppPower, DeployBadge, PendingDeploy, TRIGGER, type Deploy } from '../components/shared';
import { Badge, Button, Card, Empty, Loading, Meter, StatusBadge, StatusDot, cx } from '../components/ui';
import { ago, bytes, pct, rate, sha } from '../lib/format';
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
    if (data) setHist(data.history.slice(-90));
  }, [data]);
  useEffect(() => {
    const s = live.system;
    if (!s) return;
    setHist((h) => (h.length && h[h.length - 1]!.t >= s.t ? h : [...h.slice(-89), { t: s.t, cpu: s.cpu, mem: s.mem, rx: s.rx, tx: s.tx }]));
  }, [live.system]);
  return hist;
}

/** 서버 상태를 한 줄로: CPU · 메모리 · 디스크 · 네트워크 */
function ServerStrip({ sys, hist }: { sys: SystemNow | null; hist: Sample[] }) {
  if (!sys) return null;
  const disk = sys.disk[0];
  const cells: { icon: React.ReactNode; label: string; value: string; sub: string; spark?: number[]; max?: number; color?: string; percent?: number }[] = [
    { icon: <Cpu size={14} />, label: 'CPU', value: pct(sys.cpu), sub: `${sys.cores.length}코어`, spark: hist.map((s) => s.cpu), max: 100 },
    { icon: <MemoryStick size={14} />, label: '메모리', value: pct(sys.mem), sub: `${bytes(sys.memUsed)} / ${bytes(sys.memTotal)}`, spark: hist.map((s) => s.mem), max: 100, color: 'var(--color-info)' },
    { icon: <HardDrive size={14} />, label: '디스크', value: disk ? pct((disk.used / disk.total) * 100) : '-', sub: disk ? `${bytes(disk.total - disk.used)} 남음` : '', percent: disk ? (disk.used / disk.total) * 100 : 0 },
    { icon: <ArrowDownUp size={14} />, label: '네트워크', value: `↓ ${rate(sys.rx)}`, sub: `↑ ${rate(sys.tx)}`, spark: hist.map((s) => s.rx + s.tx), color: 'var(--color-ok)' },
  ];
  return (
    <Link to="/system" className="card grid grid-cols-2 divide-line transition-colors hover:border-line-2 lg:grid-cols-4 lg:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-line lg:[&>*:nth-child(-n+2)]:border-b-0">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0 px-4 py-3">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            {c.icon}
            {c.label}
          </div>
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="whitespace-nowrap text-lg font-bold leading-tight">{c.value}</div>
              <div className="truncate text-xs text-muted">{c.sub}</div>
            </div>
            {c.spark && c.spark.length > 1 && (
              <div className="hidden w-20 shrink-0 sm:block">
                <Sparkline values={c.spark} max={c.max} color={c.color} height={26} />
              </div>
            )}
            {c.percent !== undefined && (
              <div className="hidden w-20 shrink-0 pb-1.5 sm:block">
                <Meter value={c.percent} />
              </div>
            )}
          </div>
        </div>
      ))}
    </Link>
  );
}

const HIDE_GUIDE = 'hrone:guide-hidden';

/** 처음 쓰는 사람을 위한 순서 안내. 다 끝내거나 숨기면 사라진다 */
function GettingStarted({ me, appCount }: { me: Me; appCount: number }) {
  const { data: s } = useApi<{ githubTokenSet: boolean; discordSet: boolean }>('/api/settings');
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_GUIDE) === '1';
    } catch {
      return false;
    }
  });
  if (!s || hidden) return null;
  const steps = [
    {
      done: me.totpEnabled,
      title: '계정 지키기',
      body: '설치할 때 받은 비밀번호를 바꾸고 OTP(2단계 인증)를 켜세요.',
      action: <Button size="sm" onClick={() => navigate('/settings')}>내 계정</Button>,
    },
    {
      done: s.githubTokenSet,
      optional: true,
      title: 'GitHub 연결',
      body: '비공개 저장소를 쓸 때만 필요합니다. 연결하면 앱 추가 화면에서 내 저장소를 골라 쓸 수 있습니다.',
      action: <Button size="sm" onClick={() => navigate('/settings?tab=connect')}>토큰 넣기</Button>,
    },
    {
      done: appCount > 0,
      title: '첫 앱 배포',
      body: '저장소 주소만 넣으면 실행 방법을 알아서 찾고 바로 배포합니다.',
      action: <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => navigate('/apps/new')}>앱 추가</Button>,
    },
    {
      done: s.discordSet,
      optional: true,
      title: '디스코드 알림',
      body: '배포 성공·실패, 크래시를 디스코드로 받습니다.',
      action: <Button size="sm" onClick={() => navigate('/settings?tab=connect')}>웹후크 넣기</Button>,
    },
  ];
  if (steps.every((x) => x.done)) return null;
  const left = steps.filter((x) => !x.done && !x.optional).length;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <ListChecks size={16} className="text-accent-2" />
          시작하기
          <span className="text-xs font-normal text-muted">{left ? `필수 ${left}개 남음` : '필수 단계를 마쳤습니다'}</span>
        </span>
      }
      actions={
        <button
          type="button"
          className="text-xs text-muted hover:text-fg cursor-pointer"
          onClick={() => {
            try {
              localStorage.setItem(HIDE_GUIDE, '1');
            } catch {
              // 저장이 막힌 브라우저면 이번 화면에서만 숨긴다
            }
            setHidden(true);
          }}
        >
          숨기기
        </button>
      }
      pad={false}
    >
      <ol className="divide-y divide-line">
        {steps.map((x, i) => (
          <li key={x.title} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
            <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold', x.done ? 'bg-ok/15 text-ok' : 'bg-surface-3 text-fg-2')}>
              {x.done ? <Check size={14} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cx('text-sm font-semibold', x.done && 'text-muted line-through decoration-muted/60')}>
                {x.title}
                {x.optional && <span className="ml-1.5 text-xs font-normal text-muted">선택</span>}
              </div>
              {!x.done && <div className="mt-0.5 text-xs leading-relaxed text-muted">{x.body}</div>}
            </div>
            {!x.done && <div className="shrink-0">{x.action}</div>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Dashboard({ me }: { me: Me }) {
  useTitle('홈');
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
        <h1 className="text-2xl font-bold tracking-tight">홈</h1>
        <div className="flex gap-2">
          <Button icon={<Database size={15} />} onClick={() => navigate('/databases?new=1')}>
            DB 추가
          </Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/apps/new')}>
            앱 추가
          </Button>
        </div>
      </div>

      {data && <GettingStarted me={me} appCount={data.apps.length} />}

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

      <ServerStrip sys={live.system ?? data?.system ?? null} hist={hist} />

      {loading && !data ? (
        <Loading />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Card title={<span className="flex items-center gap-2"><Boxes size={16} /> 앱</span>} actions={data!.apps.length > 0 && <Link to="/apps" className="text-xs text-muted hover:text-fg">전체 보기</Link>} pad={false}>
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
                      <Link to={`/apps/${a.slug}`} className="flex min-w-[220px] flex-1 items-center gap-3">
                        <RuntimeIcon runtime={a.runtime} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-semibold">{a.name}</span>
                            <StatusBadge state={a.deployedSha ? st?.state : 'not-deployed'} />
                            {a.busy && <Badge tone="purple">배포 중</Badge>}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                            <span>{a.publicUrl ? a.publicUrl.replace(/^https?:\/\//, '') : <span className="mono">127.0.0.1:{a.port}</span>}</span>
                            {st?.state === 'running' && (
                              <span>
                                CPU {pct(st.cpu, 1)} · {bytes(st.memory)}
                              </span>
                            )}
                            {a.deployedAt && <span>{ago(a.deployedAt)} 배포</span>}
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

          <div className="space-y-6">
            <Card title={<span className="flex items-center gap-2"><Database size={16} /> 데이터베이스</span>} actions={data!.databases.length > 0 && <Link to="/databases" className="text-xs text-muted hover:text-fg">전체 보기</Link>} pad={false}>
              {data!.databases.length === 0 ? (
                <div className="px-5 py-7 text-center text-sm text-muted">
                  MariaDB · Redis 가 필요하면{' '}
                  <Link to="/databases?new=1" className="text-accent-2 hover:underline">
                    추가하세요
                  </Link>
                </div>
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

            {data!.recent.length > 0 && (
              <Card title={<span className="flex items-center gap-2"><GitCommitHorizontal size={16} /> 최근 배포</span>} pad={false}>
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
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
