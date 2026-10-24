import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  Link2,
  RefreshCw,
  Rocket,
  RotateCcw,
  Skull,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { AreaChart } from '../components/Charts';
import { EnvEditor } from '../components/EnvEditor';
import { FileBrowser } from '../components/FileBrowser';
import { DeployLog, LogViewer } from '../components/LogViewer';
import { AppPower, DeployBadge, PendingDeploy, TRIGGER, modeText, type Deploy } from '../components/shared';
import {
  Badge,
  Button,
  Card,
  CopyField,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  KV,
  Loading,
  Modal,
  Notice,
  StatusBadge,
  Tabs,
  Toggle,
  cx,
  toast,
  useAction,
  useConfirm,
} from '../components/ui';
import type { Me } from '../components/Layout';
import { api, errorText } from '../lib/api';
import { ago, bytes, dateTime, duration, pct, sha } from '../lib/format';
import { Link, navigate, setQuery, useLocation, useTitle } from '../lib/router';
import { useApi, useUnit, type UnitStatus } from '../lib/store';
import { AppSettings } from './AppSettings';
import { DbIcon, RuntimeIcon, type AppSummary, type DbSummary } from './Dashboard';

export interface AppConfig {
  runtime: 'node' | 'python';
  runtimeVersion: string;
  repoUrl: string;
  branch: string;
  auth: 'none' | 'token' | 'deploykey';
  rootDir: string;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  releaseCmd: string;
  installAlways: boolean;
  allowInstallScripts: boolean;
  port: number | null;
  publicUrl: string;
  writeDotenv: boolean;
  deployMode: 'auto' | 'delay' | 'manual';
  deployDelaySec: number;
  pollEnabled: boolean;
  pollIntervalSec: number;
  watchPaths: string[];
  preservePaths: string[];
  localChanges: 'overwrite' | 'keep';
  autostart: boolean;
  restartPolicy: 'always' | 'on-failure' | 'no';
  healthPath: string;
  healthTimeoutSec: number;
  autoRollback: boolean;
  runAsRoot: boolean;
  forceColor: boolean;
  resources: { cpu: number | null; memoryMB: number | null; swapMB: number | null; tasks: number | null; cpuWeight: number | null };
  notify: { push: boolean; pending: boolean; start: boolean; success: boolean; failure: boolean; crash: boolean };
  backup: { enabled: boolean; mode: 'daily' | 'interval'; time: string; intervalHours: number; keep: number };
}

export interface AppDetailData extends AppSummary {
  config: AppConfig;
  createdAt: number;
  deployKey: string | null;
  webhookPath: string;
  links: { slug: string; name: string; type: 'mariadb' | 'redis'; prefix: string; port: number; keys: string[] }[];
  envCount: number;
  history: { t: number; cpu: number; mem: number }[];
  dir: string;
  dataDir: string;
  rejectedSha: string | null;
  lastSeenSha: string | null;
}

type Tab = 'overview' | 'console' | 'files' | 'deploys' | 'env' | 'settings';

// 예전 탭 주소(?tab=links 등)로 들어와도 맞는 곳을 보여 준다
const OLD_TABS: Record<string, Tab> = { links: 'env', backups: 'settings', danger: 'settings' };

export function AppDetail({ slug, me }: { slug: string; me: Me }) {
  const { query } = useLocation();
  const raw = query.get('tab') ?? 'overview';
  const tab = (OLD_TABS[raw] ?? raw) as Tab;
  const { data: app, error, loading, reload } = useApi<AppDetailData>(`/api/apps/${slug}`, { refreshOn: ['apps', 'deploys'] });
  const unit = useUnit(`hrone-app-${slug}.service`);
  const st = unit ?? app?.status ?? null;
  useTitle(app?.name ?? slug);

  if (loading && !app) return <Loading />;
  if (error && !app) return <ErrorBox error={error} onRetry={reload} />;
  if (!app) return null;

  const state = app.deployedSha ? st?.state : 'not-deployed';
  const setTab = (t: Tab) => {
    // 파일 탭의 위치(?dir, ?file)는 다른 탭으로 넘어가면 지운다
    setQuery('dir', null);
    setQuery('file', null);
    setQuery('tab', t === 'overview' ? null : t);
  };

  return (
    <div>
      <Link to="/apps" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> 앱 목록
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <RuntimeIcon runtime={app.runtime} size={46} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight">{app.name}</h1>
              <StatusBadge state={state} />
              {app.busy && <Badge tone="purple">배포 중</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span className="mono">{app.slug}</span>
              <a href={app.repoWeb} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                <GitBranch size={13} />
                {app.repoUrl.replace(/^https?:\/\/(github\.com\/)?|\.git$/g, '')} · {app.branch}
              </a>
              <span className="mono">127.0.0.1:{app.port}</span>
              {app.publicUrl && (
                <a href={app.publicUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent-2 hover:underline">
                  <ExternalLink size={13} />
                  {app.publicUrl.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          </div>
        </div>
        <AppPower slug={slug} state={st?.state} deployed={!!app.deployedSha} size="md" />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: '개요' },
          { value: 'console', label: '로그' },
          { value: 'files', label: '파일' },
          { value: 'deploys', label: '배포', badge: app.openDeploy?.status === 'pending' ? <span className="h-1.5 w-1.5 rounded-full bg-warn" /> : undefined },
          { value: 'env', label: '환경변수', badge: app.envCount + app.links.length ? <span className="text-xs text-muted">{app.envCount + app.links.length}</span> : undefined },
          { value: 'settings', label: '설정' },
        ]}
      />

      {tab === 'overview' && <Overview app={app} st={st} reload={reload} />}
      {tab === 'console' && <LogViewer kind="app" slug={slug} />}
      {tab === 'files' && <FileBrowser slug={slug} />}
      {tab === 'deploys' && <Deploys app={app} />}
      {tab === 'env' && (
        <div className="space-y-5">
          <EnvEditor slug={slug} running={st?.state === 'running'} />
          <Links app={app} reload={reload} running={st?.state === 'running'} />
        </div>
      )}
      {tab === 'settings' && <AppSettings app={app} me={me} reload={reload} />}
    </div>
  );
}

// ---------- 개요 ----------

function Overview({ app, st, reload }: { app: AppDetailData; st: UnitStatus | null; reload: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [hist, setHist] = useState(app.history);
  useEffect(() => setHist(app.history), [app.history]);
  useEffect(() => {
    if (!st || st.state !== 'running') return;
    setHist((h) => [...h.slice(-299), { t: Date.now(), cpu: st.cpu ?? 0, mem: st.memory ?? 0 }]);
  }, [st]);
  const exposed = (st?.listen ?? []).filter((l) => !['127.0.0.1', '::1', 'localhost'].includes(l.addr));
  const wrongPort = st?.state === 'running' && (st.listen ?? []).length > 0 && app.port && !(st.listen ?? []).some((l) => l.port === app.port);
  const memLimit = app.config.resources.memoryMB ? app.config.resources.memoryMB * 1024 * 1024 : null;

  return (
    <div className="space-y-5">
      {!app.deployedSha && !app.busy && (
        <Notice tone="yellow" title="아직 배포되지 않았습니다" icon={<AlertTriangle size={16} />}>
          첫 배포가 실패했다면{' '}
          <button type="button" className="text-accent-2 underline cursor-pointer" onClick={() => setQuery('tab', 'deploys')}>
            배포 기록
          </button>
          에서 로그를 확인하고, 설정을 고친 뒤 다시 배포하세요.
        </Notice>
      )}
      {app.openDeploy && (app.openDeploy.status === 'pending' || app.openDeploy.status === 'scheduled') && <OpenDeployCard id={app.openDeploy.id} name={app.name} />}
      {exposed.length > 0 && (
        <Notice tone="red" title="외부에 노출된 포트가 있습니다" icon={<AlertTriangle size={16} />}>
          {exposed.map((l) => `${l.addr}:${l.port}`).join(', ')} 로 열려 있습니다. cloudflared 만 쓸 거라면 앱이 HOST 환경변수(127.0.0.1)로 listen 하도록 고치세요.
        </Notice>
      )}
      {wrongPort && (
        <Notice tone="yellow" title={`앱이 설정된 포트(${app.port})가 아닌 곳에서 열려 있습니다`} icon={<AlertTriangle size={16} />}>
          실제: {(st?.listen ?? []).map((l) => `${l.addr}:${l.port}`).join(', ')} — 코드에서 process.env.PORT / os.environ["PORT"] 를 쓰세요.
        </Notice>
      )}
      {app.lastPollError && (
        <Notice tone="red" title="저장소 확인 실패" icon={<AlertTriangle size={16} />}>
          {app.lastPollError}
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['CPU', st?.state === 'running' ? pct(st.cpu, 1) : '-', app.config.resources.cpu ? `상한 ${app.config.resources.cpu}코어` : '제한 없음'],
              ['메모리', st?.state === 'running' ? bytes(st.memory) : '-', memLimit ? `상한 ${bytes(memLimit, 0)}` : '제한 없음'],
              ['가동 시간', st?.state === 'running' && st.since ? duration((Date.now() - st.since) / 1000) : '-', `재시작 ${st?.restarts ?? 0}회`],
              ['프로세스', st?.state === 'running' ? `PID ${st.pid}` : '-', st?.tasks ? `스레드/작업 ${st.tasks}` : ''],
            ].map(([k, v, s]) => (
              <div key={k} className="card p-4">
                <div className="text-xs text-muted">{k}</div>
                <div className="mt-1.5 text-xl font-bold">{v}</div>
                <div className="mt-0.5 text-xs text-muted">{s}</div>
              </div>
            ))}
          </div>
          <Card title="사용량 (최근 10분)">
            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <div className="mb-2 text-xs text-muted">CPU (코어 1개 = 100%)</div>
                <AreaChart times={hist.map((h) => h.t)} series={[{ label: 'CPU', color: 'var(--color-accent)', values: hist.map((h) => h.cpu) }]} format={(v) => `${v.toFixed(0)}%`} height={130} />
              </div>
              <div>
                <div className="mb-2 text-xs text-muted">메모리</div>
                <AreaChart times={hist.map((h) => h.t)} max={memLimit ?? undefined} series={[{ label: '메모리', color: 'var(--color-info)', values: hist.map((h) => h.mem) }]} format={(v) => bytes(v, 0)} height={130} />
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="배포">
            <KV
              items={[
                ['현재 커밋', <span className="mono">{sha(app.deployedSha)}</span>],
                ['배포 시각', app.deployedAt ? `${ago(app.deployedAt)} (${dateTime(app.deployedAt)})` : '-'],
                ['푸시하면', modeText(app.deployMode, app.deployDelaySec)],
                ['새 커밋 확인', app.config.pollEnabled ? `${app.config.pollIntervalSec}초마다 · 마지막 ${ago(app.lastPollAt)}` : '꺼짐 (웹후크만)'],
                ...(app.rejectedSha && app.lastSeenSha === app.rejectedSha
                  ? ([[ '건너뛴 커밋', <span className="mono text-warn">{sha(app.rejectedSha)} (거절/실패/롤백)</span> ]] as [string, React.ReactNode][])
                  : []),
              ]}
            />
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<Rocket size={14} />}
                loading={busy === 'deploy'}
                onClick={async () => {
                  if (!(await confirm({ title: '지금 배포', body: '원격 브랜치의 최신 커밋을 받아 바로 배포합니다 (적용 방식과 상관없이).', confirm: '배포' }))) return;
                  run('deploy', async () => {
                    const r = await api.post<{ id: number }>(`/api/apps/${app.slug}/deploy`, {});
                    navigate(`/apps/${app.slug}?tab=deploys&deploy=${r.id}`);
                  });
                }}
              >
                지금 배포
              </Button>
              <Button
                size="sm"
                icon={<RefreshCw size={14} />}
                loading={busy === 'check'}
                disabled={!app.deployedSha}
                onClick={() =>
                  run('check', async () => {
                    const r = await api.post<{ sha: string; upToDate: boolean }>(`/api/apps/${app.slug}/check`);
                    toast.info(r.upToDate ? '이미 최신입니다' : `새 커밋 ${sha(r.sha)} 발견 — ${modeText(app.deployMode, app.deployDelaySec)}`);
                    reload();
                  })
                }
              >
                새 커밋 확인
              </Button>
            </div>
          </Card>
          <Card title="접속">
            <div className="space-y-3 text-sm">
              {app.publicUrl ? (
                <a href={app.publicUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-accent-2 hover:underline">
                  <ExternalLink size={14} />
                  {app.publicUrl.replace(/^https?:\/\//, '')}
                </a>
              ) : (
                app.port && (
                  <p className="text-muted">
                    인터넷에 공개하려면 cloudflared 터널의 서비스 주소를 아래 주소로 지정하세요. 공개 주소는 설정 → 기본에 적어 두면 여기 링크로 나옵니다.
                  </p>
                )
              )}
              {app.port ? <CopyField value={`http://127.0.0.1:${app.port}`} /> : <p className="text-muted">포트 없이 실행되는 앱입니다 (봇 등).</p>}
              {(st?.listen ?? []).length > 0 && <div className="text-xs text-muted">실제로 열린 주소: <span className="mono">{st!.listen.map((l) => `${l.addr}:${l.port}`).join(', ')}</span></div>}
            </div>
          </Card>
          <Card title="실행">
            <div className="space-y-4">
              <KV
                items={[
                  ['런타임', `${app.runtime === 'node' ? 'Node.js' : 'Python'} ${app.runtimeVersion}`],
                  ['시작 명령', <code className="text-[12.5px]">{app.config.startCmd || '-'}</code>],
                  ['폴더', <span className="mono text-[12px] break-all">{app.dir}</span>],
                ]}
              />
              <div className="border-t border-line pt-4">
                <Toggle
                  checked={app.autostart}
                  onChange={(v) => run('auto', () => api.post(`/api/apps/${app.slug}/autostart`, { enabled: v }), v ? '재부팅 시 자동 시작합니다' : '자동 시작을 껐습니다').then(reload)}
                  label="재부팅 시 자동 시작"
                />
              </div>
              {app.deployedSha && (st?.state === 'running' || st?.state === 'restarting' || st?.state === 'starting') && (
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Skull size={14} />}
                  loading={busy === 'kill'}
                  onClick={async () => {
                    if (!(await confirm({ title: '강제 종료 (SIGKILL)', body: '정상 종료를 기다리지 않고 프로세스를 즉시 죽입니다. 저장 중이던 데이터가 손상될 수 있습니다. 응답이 없을 때만 쓰세요.', confirm: '강제 종료', danger: true }))) return;
                    run('kill', () => api.post(`/api/apps/${app.slug}/action`, { action: 'kill' }), '강제 종료했습니다');
                  }}
                >
                  강제 종료
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function OpenDeployCard({ id, name }: { id: number; name: string }) {
  const { data } = useApi<Deploy>(`/api/deploys/${id}`, { refreshOn: ['deploys'] });
  if (!data) return null;
  return (
    <div className="card border-warn/30 p-4">
      <PendingDeploy d={{ ...data, appName: name }} />
    </div>
  );
}

// ---------- 배포 ----------

function Deploys({ app }: { app: AppDetailData }) {
  const { query } = useLocation();
  const { data, loading, reload } = useApi<Deploy[]>(`/api/apps/${app.slug}/deploys`, { refreshOn: ['deploys'] });
  const [openId, setOpenId] = useState<number | null>(Number(query.get('deploy')) || null);
  const [diffFor, setDiffFor] = useState<Deploy | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  useEffect(() => {
    if (!openId && data?.length) setOpenId(data[0]!.id);
  }, [data, openId]);

  if (loading && !data) return <Loading />;
  if (!data?.length) return <Empty icon={<History size={22} />} title="배포 기록이 없습니다" />;

  return (
    <div className="space-y-3">
      {data.map((d) => {
        const open = openId === d.id;
        const head = d.commits[0];
        const dur = d.started_at && d.finished_at ? Math.round((d.finished_at - d.started_at) / 1000) : null;
        return (
          <div key={d.id} className={cx('card overflow-hidden', open && 'border-line-2')}>
            <button type="button" onClick={() => setOpenId(open ? null : d.id)} className="flex w-full flex-wrap items-center gap-3 px-5 py-3.5 text-left hover:bg-surface-2/60 cursor-pointer">
              <span className="mono text-xs text-muted">#{d.id}</span>
              <DeployBadge status={d.status} />
              <span className="mono text-sm">{sha(d.to_sha)}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{head?.message ?? TRIGGER[d.trigger]}</span>
              <span className="text-xs text-muted">
                {TRIGGER[d.trigger]}
                {d.triggered_by ? ` · ${d.triggered_by}` : ''} · {ago(d.created_at)}
                {dur !== null ? ` · ${dur}초` : ''}
              </span>
            </button>
            {open && (
              <div className="space-y-4 border-t border-line px-5 py-4">
                {(d.status === 'pending' || d.status === 'scheduled' || d.status === 'queued') && <PendingDeploy d={d} compact />}
                {d.error && (
                  <div className="rounded-lg border border-bad/25 bg-bad/8 px-3 py-2 text-sm text-bad">{d.error}</div>
                )}
                {d.commits.length > 0 && (
                  <div className="space-y-1">
                    {d.commits.slice(0, 15).map((c) => (
                      <div key={c.sha} className="flex items-center gap-2 text-sm">
                        <GitCommitHorizontal size={14} className="shrink-0 text-muted" />
                        <a href={app.repoWeb ? `${app.repoWeb}/commit/${c.sha}` : undefined} target="_blank" rel="noreferrer" className="mono text-xs text-accent-2 hover:underline">
                          {sha(c.sha)}
                        </a>
                        <span className="min-w-0 flex-1 truncate">{c.message}</span>
                        <span className="shrink-0 text-xs text-muted">
                          {c.author} · {ago(c.date)}
                        </span>
                      </div>
                    ))}
                    {d.commits.length > 15 && <div className="text-xs text-muted">외 {d.commits.length - 15}개</div>}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {d.to_sha && d.from_sha && d.to_sha !== d.from_sha && (
                    <Button size="sm" icon={<FileDiff size={14} />} onClick={() => setDiffFor(d)}>
                      변경 내용 보기
                    </Button>
                  )}
                  {d.status === 'success' && d.to_sha !== app.deployedSha && (
                    <Button
                      size="sm"
                      variant="warn"
                      icon={<Undo2 size={14} />}
                      loading={busy === `rb${d.id}`}
                      onClick={async () => {
                        if (!(await confirm({ title: `${sha(d.to_sha)} 으로 롤백`, body: '이 버전으로 되돌립니다. 원격의 최신 커밋은 새 푸시가 올 때까지 자동 배포하지 않습니다.', confirm: '롤백' }))) return;
                        run(`rb${d.id}`, async () => {
                          const r = await api.post<{ id: number }>(`/api/apps/${app.slug}/rollback`, { deployId: d.id });
                          setOpenId(r.id);
                          reload();
                        });
                      }}
                    >
                      이 버전으로 롤백
                    </Button>
                  )}
                  {(d.status === 'failed' || d.status === 'rolled_back') && (
                    <Button
                      size="sm"
                      icon={<RotateCcw size={14} />}
                      loading={busy === `re${d.id}`}
                      onClick={() =>
                        run(`re${d.id}`, async () => {
                          const r = await api.post<{ id: number }>(`/api/apps/${app.slug}/deploy`, { sha: d.to_sha });
                          setOpenId(r.id);
                          reload();
                        })
                      }
                    >
                      다시 시도
                    </Button>
                  )}
                </div>
                {d.status !== 'pending' && d.status !== 'scheduled' && d.status !== 'superseded' && d.status !== 'rejected' && d.status !== 'cancelled' && (
                  <DeployLog id={d.id} running={d.status === 'running' || d.status === 'queued'} />
                )}
              </div>
            )}
          </div>
        );
      })}
      <DiffModal deploy={diffFor} onClose={() => setDiffFor(null)} />
    </div>
  );
}

function DiffModal({ deploy, onClose }: { deploy: Deploy | null; onClose: () => void }) {
  const [stat, setStat] = useState<{ file: string; add: number; del: number }[] | null>(null);
  const [web, setWeb] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [patch, setPatch] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!deploy) return;
    setStat(null);
    setFile(null);
    setPatch('');
    api
      .get<{ stat: { file: string; add: number; del: number }[]; web: string }>(`/api/deploys/${deploy.id}/diff`)
      .then((r) => {
        setStat(r.stat);
        setWeb(r.web);
      })
      .catch((e) => toast.error(errorText(e)));
  }, [deploy]);
  useEffect(() => {
    if (!deploy || file === null) return;
    setLoading(true);
    const f = file.includes(' → ') ? file.split(' → ')[1]! : file;
    api
      .get<{ patch: string }>(`/api/deploys/${deploy.id}/diff?file=${encodeURIComponent(f)}`)
      .then((r) => setPatch(r.patch))
      .catch((e) => toast.error(errorText(e)))
      .finally(() => setLoading(false));
  }, [deploy, file]);
  return (
    <Modal open={!!deploy} onClose={onClose} title={deploy ? `변경 내용 ${sha(deploy.from_sha)} → ${sha(deploy.to_sha)}` : ''} width={980}>
      {!stat ? (
        <Loading />
      ) : (
        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <div className="max-h-[60vh] space-y-0.5 overflow-auto">
            {web.startsWith('https://github.com/') && deploy?.from_sha && (
              <a href={`${web}/compare/${deploy.from_sha}...${deploy.to_sha}`} target="_blank" rel="noreferrer" className="mb-2 flex items-center gap-1 text-xs text-accent-2 hover:underline">
                <ExternalLink size={12} /> GitHub 에서 비교
              </a>
            )}
            <div className="mb-1 text-xs text-muted">파일 {stat.length}개</div>
            {stat.map((s) => (
              <button
                key={s.file}
                type="button"
                onClick={() => setFile(s.file)}
                className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs cursor-pointer', file === s.file ? 'bg-surface-3' : 'hover:bg-surface-2')}
              >
                <span className="mono min-w-0 flex-1 truncate">{s.file}</span>
                {s.add >= 0 ? (
                  <span className="shrink-0">
                    <span className="text-ok">+{s.add}</span> <span className="text-bad">-{s.del}</span>
                  </span>
                ) : (
                  <span className="text-muted">바이너리</span>
                )}
              </button>
            ))}
          </div>
          <div className="mono max-h-[60vh] min-h-[200px] overflow-auto rounded-xl border border-line bg-code p-3 text-[12px] leading-[1.55] whitespace-pre">
            {file === null ? (
              <span className="text-muted">왼쪽에서 파일을 고르세요</span>
            ) : loading ? (
              <span className="text-muted">불러오는 중...</span>
            ) : (
              patch.split('\n').map((l, i) => (
                <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'bg-ok/10 text-ok' : l.startsWith('-') && !l.startsWith('---') ? 'bg-bad/10 text-bad' : l.startsWith('@@') ? 'text-info' : 'text-fg-2'}>
                  {l || ' '}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------- DB 연결 ----------

function Links({ app, reload, running }: { app: AppDetailData; reload: () => void; running: boolean }) {
  const { data: dbs } = useApi<DbSummary[]>('/api/databases');
  const [db, setDb] = useState('');
  const [prefix, setPrefix] = useState('');
  const { busy, run } = useAction();
  const available = (dbs ?? []).filter((d) => !app.links.some((l) => l.slug === d.slug));
  const afterChange = async (restartNeeded: boolean) => {
    reload();
    if (restartNeeded && running) {
      toast.info('연결 정보가 바뀌었습니다. 앱을 재시작해야 반영됩니다.');
    }
  };
  return (
    <Card title="데이터베이스 연결" pad={false}>
      {app.links.length === 0 ? (
        <div className="px-5 pt-4 text-sm text-muted">MariaDB · Redis 를 연결하면 접속 정보(DATABASE_URL, REDIS_URL 등)가 환경변수로 자동으로 들어갑니다.</div>
      ) : (
        <div className="divide-y divide-line">
          {app.links.map((l) => (
            <div key={l.slug} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <DbIcon type={l.type} size={32} />
              <div className="min-w-0 flex-1">
                <Link to={`/databases/${l.slug}`} className="font-semibold hover:underline">
                  {l.name}
                </Link>
                <div className="mono mt-0.5 text-xs text-muted">{l.keys.join(' · ')}</div>
              </div>
              {l.prefix && <Badge tone="purple">접두사 {l.prefix}</Badge>}
              <IconButton
                title="연결 해제"
                onClick={() =>
                  run(`rm${l.slug}`, async () => {
                    const r = await api.del<{ restartNeeded: boolean }>(`/api/apps/${app.slug}/links/${l.slug}`);
                    await afterChange(r.restartNeeded);
                  }, '연결을 해제했습니다')
                }
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div className={cx('px-5 py-4', app.links.length > 0 && 'border-t border-line')}>
        {available.length === 0 ? (
          <div className="text-sm text-muted">
            {app.links.length ? '더 연결할 DB 가 없습니다.' : '아직 DB 가 없습니다.'}{' '}
            <Link to="/databases?new=1" className="text-accent-2 hover:underline">
              새 DB 만들기
            </Link>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="연결할 DB" className="min-w-[200px] flex-1">
              <select className="input" value={db} onChange={(e) => setDb(e.target.value)}>
                <option value="">선택...</option>
                {available.map((d) => (
                  <option key={d.slug} value={d.slug}>
                    {d.name} ({d.type === 'mariadb' ? 'MariaDB' : 'Redis'} :{d.port})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="변수 접두사 (선택)" className="w-48" hint="예: CACHE_ → CACHE_REDIS_URL">
              <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="없음" />
            </Field>
            <Button
              variant="primary"
              icon={<Link2 size={15} />}
              disabled={!db}
              loading={busy === 'add'}
              onClick={() =>
                run('add', async () => {
                  const r = await api.post<{ restartNeeded: boolean }>(`/api/apps/${app.slug}/links`, { database: db, prefix });
                  setDb('');
                  setPrefix('');
                  await afterChange(r.restartNeeded);
                }, '연결했습니다')
              }
            >
              연결
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
