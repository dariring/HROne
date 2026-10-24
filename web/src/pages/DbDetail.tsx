import { ArrowLeft, Eraser, KeyRound, Play, Plus, RotateCw, Save, SlidersHorizontal, Square, Terminal, Trash2, Unlock, Upload, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DangerDialog, JobDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { LogViewer } from '../components/LogViewer';
import {
  Badge,
  Button,
  Card,
  CopyField,
  Disclosure,
  ErrorBox,
  Field,
  Fold,
  IconButton,
  KV,
  Loading,
  Meter,
  Modal,
  Notice,
  StatusBadge,
  Tabs,
  Toggle,
  toast,
  useAction,
  useConfirm,
} from '../components/ui';
import { api, errorText } from '../lib/api';
import { bytes, dateTime, duration } from '../lib/format';
import { Link, navigate, setQuery, useLocation, useTitle } from '../lib/router';
import { useApi, useUnit } from '../lib/store';
import { BackupList, type Backup } from './Backups';
import { DbIcon, type DbSummary } from './Dashboard';

interface MariaLimits {
  maxConnections: number;
  maxUserConnections: number;
  maxConnectErrors: number;
  waitTimeout: number;
  maxAllowedPacketMB: number;
  innodbBufferPoolMB: number;
  tableOpenCache: number;
  threadCacheSize: number;
}
interface RedisLimits {
  maxClients: number;
  maxMemoryMB: number;
  maxMemoryPolicy: string;
  timeout: number;
  appendonly: boolean;
  save: string;
}
interface DbDetailData extends DbSummary {
  config: {
    port: number;
    bind: string;
    autostart: boolean;
    resources: { cpu: number | null; memoryMB: number | null; swapMB: number | null; tasks: number | null; cpuWeight: number | null };
    limits: MariaLimits | RedisLimits;
    backup: { enabled: boolean; mode: 'daily' | 'interval'; time: string; intervalHours: number; keep: number };
    defaultDb: string;
    appUser: string;
    adminUser: string;
  };
  createdAt: number;
  dataDir: string;
}

type Tab = 'overview' | 'query' | 'schemas' | 'backups' | 'console' | 'settings';

// 예전 탭 주소로 들어와도 맞는 곳을 보여 준다
const OLD_TABS: Record<string, Tab> = { limits: 'settings', danger: 'settings' };

export function DbDetail({ slug, me }: { slug: string; me: Me }) {
  const { query } = useLocation();
  const raw = query.get('tab') ?? 'overview';
  const tab = (OLD_TABS[raw] ?? raw) as Tab;
  const { data: db, error, loading, reload } = useApi<DbDetailData>(`/api/databases/${slug}`, { refreshOn: ['databases', 'jobs'] });
  const unit = useUnit(`hrone-db-${slug}.service`);
  const st = unit ?? db?.status ?? null;
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [job, setJob] = useState<number | null>(null);
  useTitle(db?.name ?? slug);
  if (loading && !db) return <Loading />;
  if (error && !db) return <ErrorBox error={error} onRetry={reload} />;
  if (!db) return null;
  const maria = db.type === 'mariadb';
  const act = (a: string) => run(a, () => api.post(`/api/databases/${slug}/action`, { action: a }), a === 'start' ? '시작했습니다' : a === 'stop' ? '정지했습니다' : '재시작했습니다');
  const on = st?.state === 'running' || st?.state === 'starting';

  return (
    <div>
      <Link to="/databases" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> 데이터베이스
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <DbIcon type={db.type} size={46} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight">{db.name}</h1>
              {db.job ? <Badge tone="blue">준비 중</Badge> : <StatusBadge state={db.initialized ? st?.state : 'not-deployed'} />}
            </div>
            <div className="mt-1 text-sm text-muted">
              {maria ? 'MariaDB' : 'Redis'} · <span className="mono">{db.slug}</span> · {db.bind === 'local' ? '127.0.0.1' : db.bind === 'all' ? '0.0.0.0' : db.bind}:{db.port}
            </div>
          </div>
        </div>
        {db.initialized ? (
          <div className="flex gap-1.5">
            {!on ? (
              <Button variant="success" icon={<Play size={14} />} loading={busy === 'start'} onClick={() => act('start')}>
                시작
              </Button>
            ) : (
              <Button
                icon={<Square size={13} />}
                loading={busy === 'stop'}
                onClick={async () => {
                  if (await confirm({ title: 'DB 정지', body: db.linkedApps.length ? `연결된 앱(${db.linkedApps.map((a) => a.name).join(', ')})이 DB 에 접속하지 못하게 됩니다.` : 'DB 를 정지합니다.', confirm: '정지' })) act('stop');
                }}
              >
                정지
              </Button>
            )}
            <Button icon={<RotateCw size={14} />} loading={busy === 'restart'} onClick={() => act('restart')}>
              재시작
            </Button>
          </div>
        ) : (
          !db.job && (
            <Button variant="primary" loading={busy === 'init'} onClick={() => run('init', async () => setJob((await api.post<{ jobId: number }>(`/api/databases/${slug}/init`)).jobId))}>
              초기화 다시 시도
            </Button>
          )
        )}
      </div>

      {db.job && (
        <div className="mb-5">
          <Notice tone="blue" title={db.job.title}>
            설치/초기화가 진행 중입니다.{' '}
            <button type="button" className="text-accent-2 underline cursor-pointer" onClick={() => setJob(db.job!.id)}>
              진행 상황 보기
            </button>
          </Notice>
        </div>
      )}

      <Tabs
        value={tab}
        onChange={(t) => setQuery('tab', t === 'overview' ? null : t)}
        tabs={[
          { value: 'overview', label: '개요' },
          { value: 'query', label: maria ? 'SQL 콘솔' : 'Redis 콘솔' },
          ...(maria ? [{ value: 'schemas' as Tab, label: 'DB · 계정' }] : []),
          { value: 'backups', label: '백업' },
          { value: 'console', label: '로그' },
          { value: 'settings', label: '설정' },
        ]}
      />

      {tab === 'overview' && <Overview db={db} running={st?.state === 'running'} reload={reload} />}
      {tab === 'console' && <LogViewer kind="db" slug={slug} />}
      {tab === 'query' && <QueryConsole db={db} />}
      {tab === 'schemas' && maria && <Schemas db={db} me={me} />}
      {tab === 'backups' && <DbBackups db={db} me={me} reload={reload} />}
      {tab === 'settings' && (
        <div className="space-y-3">
          <DbSettings db={db} reload={reload} />
          <Fold icon={<Unlock size={16} />} title="연결 제한" summary={limitSummary(db)}>
            <Limits db={db} reload={reload} running={st?.state === 'running'} />
          </Fold>
          <Fold icon={<Trash2 size={16} />} title="삭제" summary="DB 와 데이터를 지웁니다" danger>
            <Danger db={db} me={me} />
          </Fold>
        </div>
      )}
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reload} />
    </div>
  );
}

function useDbStatus(slug: string, running: boolean) {
  return useApi<{ status: Record<string, any> | null }>(running ? `/api/databases/${slug}/status` : null, { interval: 5000 });
}

function Overview({ db, running, reload }: { db: DbDetailData; running: boolean; reload: () => void }) {
  const { data } = useDbStatus(db.slug, running);
  const s = data?.status;
  const maria = db.type === 'mariadb';
  const [creds, setCreds] = useState<any>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const reveal = async () => {
    const c = creds ?? (await api.get(`/api/databases/${db.slug}/credentials`));
    setCreds(c);
    return c;
  };
  const conn = s && !s.error ? (maria ? { cur: Number(s.Threads_connected), max: Number(s.max_connections), peak: Number(s.Max_used_connections) } : { cur: s.connectedClients, max: s.maxClients, peak: null }) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <Card title="접속 정보" actions={<Button size="sm" variant="ghost" onClick={reveal}>비밀번호 보기</Button>}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="호스트 / 포트">
                <CopyField value={`127.0.0.1:${db.config.port}`} />
              </Field>
              {maria && (
                <Field label="기본 DB">
                  <CopyField value={db.config.defaultDb} />
                </Field>
              )}
            </div>
            {maria ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="앱 계정" hint={`${db.config.defaultDb} DB 에만 권한`}>
                    <CopyField value={db.config.appUser} />
                  </Field>
                  <Field label="앱 계정 비밀번호">
                    <CopyField value={creds?.app.password ?? '********'} secret onReveal={async () => (await reveal()).app.password} />
                  </Field>
                  <Field label="관리자 계정" hint="모든 권한 (DB 툴 접속용)">
                    <CopyField value={db.config.adminUser} />
                  </Field>
                  <Field label="관리자 비밀번호">
                    <CopyField value={creds?.admin.password ?? '********'} secret onReveal={async () => (await reveal()).admin.password} />
                  </Field>
                </div>
                <Field label="DATABASE_URL">
                  <CopyField value={creds?.url ?? `mysql://${db.config.appUser}:********@127.0.0.1:${db.config.port}/${db.config.defaultDb}`} secret onReveal={async () => (await reveal()).url} />
                </Field>
              </>
            ) : (
              <>
                <Field label="비밀번호 (requirepass)">
                  <CopyField value={creds?.admin.password ?? '********'} secret onReveal={async () => (await reveal()).admin.password} />
                </Field>
                <Field label="REDIS_URL">
                  <CopyField value={creds?.url ?? `redis://:********@127.0.0.1:${db.config.port}/0`} secret onReveal={async () => (await reveal()).url} />
                </Field>
              </>
            )}
            {db.bind !== 'local' && <Notice tone="yellow">모든 인터페이스에서 접속을 받고 있습니다. Tailscale IP 로 PC 의 DB 툴에서 접속할 수 있습니다.</Notice>}
          </div>
        </Card>
        {s?.error && <ErrorBox error={s.error} />}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="card p-4">
            <div className="text-xs text-muted">연결</div>
            <div className="mt-1.5 text-xl font-bold">{conn ? `${conn.cur} / ${conn.max}` : '-'}</div>
            {conn && <div className="mt-2"><Meter value={(conn.cur / Math.max(1, conn.max)) * 100} /></div>}
            {conn?.peak !== null && conn && <div className="mt-1 text-xs text-muted">최대 사용 {conn.peak}</div>}
          </div>
          <div className="card p-4">
            <div className="text-xs text-muted">메모리</div>
            <div className="mt-1.5 text-xl font-bold">{maria ? bytes(Number(s?.innodb_buffer_pool_size ?? 0), 0) : bytes(s?.usedMemory)}</div>
            <div className="mt-0.5 text-xs text-muted">{maria ? '버퍼 풀' : s?.maxMemory ? `상한 ${bytes(s.maxMemory)}` : '상한 없음'}</div>
          </div>
          <div className="card p-4">
            <div className="text-xs text-muted">가동 시간</div>
            <div className="mt-1.5 text-xl font-bold">{s ? duration(maria ? Number(s.Uptime) : s.uptime) : '-'}</div>
            <div className="mt-0.5 text-xs text-muted">버전 {maria ? String(s?.version ?? '').split('-')[0] : s?.version}</div>
          </div>
          <div className="card p-4">
            <div className="text-xs text-muted">{maria ? '쿼리' : '초당 명령'}</div>
            <div className="mt-1.5 text-xl font-bold">{s ? (maria ? Number(s.Questions).toLocaleString() : s.opsPerSec) : '-'}</div>
            <div className="mt-0.5 text-xs text-muted">{maria ? `느린 쿼리 ${s?.Slow_queries ?? '-'}` : `키 ${s ? Object.values(s.keyspace as Record<string, number>).reduce((a, b) => a + b, 0) : '-'}`}</div>
          </div>
        </div>
        {maria && s && Number(s.Connection_errors_max_connections) > 0 && (
          <Notice tone="yellow" title={`연결 수 초과로 거부된 접속이 ${s.Connection_errors_max_connections}번 있었습니다`}>
            설정 → 연결 제한에서 "제한 해제" 를 누르거나 max_connections 를 올리세요.
          </Notice>
        )}
        {!maria && s && s.rejectedConnections > 0 && <Notice tone="yellow" title={`거부된 연결 ${s.rejectedConnections}회`}>설정 → 연결 제한에서 maxclients 를 올리세요.</Notice>}

      </div>
      <div className="space-y-5">
        <Card title="연결된 앱">
          {db.linkedApps.length === 0 ? (
            <div className="text-sm text-muted">없음 · 앱 → 환경변수 탭에서 이 DB 를 연결하면 접속 정보가 자동으로 들어갑니다</div>
          ) : (
            <div className="space-y-2">
              {db.linkedApps.map((a) => (
                <Link key={a.slug} to={`/apps/${a.slug}?tab=env`} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                  {a.name}
                  {a.prefix && <Badge>{a.prefix}</Badge>}
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card title="관리">
          <div className="space-y-4">
            <KV
              items={[
                ['데이터 폴더', <span className="mono text-[12px] break-all">{db.dataDir}</span>],
                ['만든 날', dateTime(db.createdAt)],
                ['자동 백업', db.config.backup.enabled ? (db.config.backup.mode === 'daily' ? `매일 ${db.config.backup.time}` : `${db.config.backup.intervalHours}시간마다`) + ` · ${db.config.backup.keep}개 보관` : '꺼짐'],
              ]}
            />
            <Toggle
              checked={db.config.autostart}
              onChange={(v) => run('auto', () => api.patch(`/api/databases/${db.slug}`, { autostart: v }), v ? '재부팅 시 자동 시작합니다' : '자동 시작을 껐습니다').then(reload)}
              label="재부팅 시 자동 시작"
            />
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {(maria ? (['app', 'admin'] as const) : (['admin'] as const)).map((w) => (
                <Button
                  key={w}
                  size="sm"
                  icon={<KeyRound size={14} />}
                  loading={busy === w}
                  disabled={!running}
                  onClick={async () => {
                    if (!(await confirm({ title: `${w === 'app' ? '앱 계정' : maria ? '관리자' : ''} 비밀번호 변경`, body: '새 비밀번호를 만들고, 연결된 앱의 환경변수도 바꿉니다. 앱은 재시작해야 새 비밀번호를 씁니다.', confirm: '변경' }))) return;
                    run(w, async () => {
                      await api.post(`/api/databases/${db.slug}/password`, { which: w });
                      setCreds(null);
                    }, '비밀번호를 바꿨습니다. 연결된 앱을 재시작하세요.');
                  }}
                >
                  {maria ? (w === 'app' ? '앱 계정 비밀번호 변경' : '관리자 비밀번호 변경') : '비밀번호 변경'}
                </Button>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function QueryConsole({ db }: { db: DbDetailData }) {
  const maria = db.type === 'mariadb';
  const [text, setText] = useState(maria ? 'SHOW TABLES;' : 'INFO keyspace');
  const [database, setDatabase] = useState(maria ? db.config.defaultDb : '0');
  const [out, setOut] = useState<{ output: string; ms: number } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`hrone:q:${db.slug}`) ?? '[]');
    } catch {
      return [];
    }
  });
  const { data: schemas } = useApi<{ name: string }[]>(maria ? `/api/databases/${db.slug}/schemas` : null);
  const exec = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ output: string; ms: number }>(`/api/databases/${db.slug}/query`, { text, database });
      setOut(r);
      const h = [text, ...history.filter((x) => x !== text)].slice(0, 20);
      setHistory(h);
      localStorage.setItem(`hrone:q:${db.slug}`, JSON.stringify(h));
    } catch (e) {
      setErr(errorText(e));
      setOut(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card
        title={<span className="flex items-center gap-2"><Terminal size={16} /> {maria ? 'SQL (root 권한으로 실행)' : 'redis-cli (한 줄에 명령 하나)'}</span>}
        actions={
          maria ? (
            <select className="input h-8 w-48 py-0 text-[13px]" value={database} onChange={(e) => setDatabase(e.target.value)}>
              <option value="">(DB 선택 안 함)</option>
              {(schemas ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            <select className="input h-8 w-28 py-0 text-[13px]" value={database} onChange={(e) => setDatabase(e.target.value)}>
              {Array.from({ length: 16 }, (_, i) => (
                <option key={i} value={String(i)}>
                  db{i}
                </option>
              ))}
            </select>
          )
        }
      >
        <textarea
          className="input mono min-h-[140px] text-[13px] leading-relaxed"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              exec();
            }
          }}
          spellCheck={false}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Play size={14} />} loading={busy} onClick={exec}>
            실행 <span className="text-xs opacity-70">⌘/Ctrl+Enter</span>
          </Button>
          {history.length > 0 && (
            <select className="input h-9 w-64 py-0 text-[13px]" value="" onChange={(e) => e.target.value && setText(e.target.value)}>
              <option value="">최근 실행...</option>
              {history.map((h, i) => (
                <option key={i} value={h}>
                  {h.replace(/\s+/g, ' ').slice(0, 60)}
                </option>
              ))}
            </select>
          )}
          {out && <span className="ml-auto text-xs text-muted">{out.ms}ms</span>}
        </div>
      </Card>
      {err && <div className="mono whitespace-pre-wrap rounded-xl border border-bad/30 bg-bad/10 p-3 text-[12.5px] text-bad">{err}</div>}
      {out && <pre className="mono max-h-[60vh] overflow-auto rounded-xl border border-line bg-[#07090d] p-4 text-[12.5px] leading-[1.5] text-fg-2">{out.output || '(출력 없음)'}</pre>}
    </div>
  );
}

function Schemas({ db, me }: { db: DbDetailData; me: Me }) {
  const { data: schemas, reload } = useApi<{ name: string; size: number; tables: number }[]>(`/api/databases/${db.slug}/schemas`);
  const { data: users, reload: reloadUsers } = useApi<{ user: string; host: string; maxConnections: number }[]>(`/api/databases/${db.slug}/users`);
  const [newDb, setNewDb] = useState('');
  const [grant, setGrant] = useState(true);
  const [drop, setDrop] = useState<string | null>(null);
  const [userModal, setUserModal] = useState(false);
  const [created, setCreated] = useState<{ user: string; password: string } | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card title="데이터베이스" pad={false}>
        <div className="divide-y divide-line">
          {(schemas ?? []).map((s) => (
            <div key={s.name} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <span className="mono flex-1">{s.name}</span>
              <span className="text-xs text-muted">테이블 {s.tables} · {bytes(s.size)}</span>
              <IconButton title="삭제" onClick={() => setDrop(s.name)}>
                <Trash2 size={15} />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <input className="input mono w-48" placeholder="새 DB 이름" value={newDb} onChange={(e) => setNewDb(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} />
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} className="accent-[var(--color-accent)]" />
            앱 계정({db.config.appUser})에 권한
          </label>
          <Button size="sm" icon={<Plus size={14} />} disabled={!newDb} loading={busy === 'db'} onClick={() => run('db', () => api.post(`/api/databases/${db.slug}/schemas`, { name: newDb, grantApp: grant }).then(() => (setNewDb(''), reload())), '만들었습니다')}>
            만들기
          </Button>
        </div>
      </Card>
      <Card title="계정" pad={false} actions={<Button size="sm" icon={<UserPlus size={14} />} onClick={() => setUserModal(true)}>계정 추가</Button>}>
        <div className="divide-y divide-line">
          {(users ?? []).map((u) => (
            <div key={`${u.user}@${u.host}`} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <span className="mono flex-1">
                {u.user}
                <span className="text-muted">@{u.host}</span>
              </span>
              {u.user === db.config.appUser && <Badge tone="purple">앱</Badge>}
              {u.user === db.config.adminUser && <Badge tone="yellow">관리자</Badge>}
              {u.user === 'root' && <Badge>소켓 전용</Badge>}
              {u.user !== 'root' && u.user !== db.config.adminUser && u.user !== db.config.appUser && (
                <>
                  <IconButton
                    title="비밀번호 재설정"
                    onClick={() => run(`pw${u.user}`, async () => setCreated(await api.post(`/api/databases/${db.slug}/users/${encodeURIComponent(u.user)}/password`, { host: u.host }).then((r: any) => ({ user: u.user, password: r.password }))))}
                  >
                    <KeyRound size={15} />
                  </IconButton>
                  <IconButton
                    title="삭제"
                    onClick={async () => {
                      if (!(await confirm({ title: `계정 ${u.user} 삭제`, confirm: '삭제', danger: true }))) return;
                      run(`rm${u.user}`, () => api.post(`/api/databases/${db.slug}/users/${encodeURIComponent(u.user)}/drop`, { host: u.host }).then(reloadUsers), '삭제했습니다');
                    }}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </>
              )}
            </div>
          ))}
        </div>
      </Card>
      <DangerDialog
        open={!!drop}
        onClose={() => setDrop(null)}
        title={`DB ${drop} 삭제`}
        target={drop ?? ''}
        needTotp={me.totpEnabled}
        items={[`데이터베이스 ${drop} 의 모든 테이블과 데이터 (삭제 직전에 전체 백업을 자동으로 만듭니다)`]}
        onConfirm={async (auth) => {
          await api.post(`/api/databases/${db.slug}/schemas/${drop}/drop`, auth);
          toast.ok('삭제했습니다');
          reload();
        }}
      />
      <NewUserModal open={userModal} onClose={() => setUserModal(false)} db={db} schemas={(schemas ?? []).map((s) => s.name)} onCreated={(c) => (setCreated(c), reloadUsers())} />
      <Modal open={!!created} onClose={() => setCreated(null)} title="계정 정보" width={460} footer={<Button onClick={() => setCreated(null)}>닫기</Button>}>
        <div className="space-y-3">
          <Notice tone="yellow">비밀번호는 지금만 보여 줍니다. 복사해 두세요.</Notice>
          <Field label="계정">
            <CopyField value={created?.user ?? ''} />
          </Field>
          <Field label="비밀번호">
            <CopyField value={created?.password ?? ''} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function NewUserModal({ open, onClose, db, schemas, onCreated }: { open: boolean; onClose: () => void; db: DbDetailData; schemas: string[]; onCreated: (c: { user: string; password: string }) => void }) {
  const [user, setUser] = useState('');
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setUser('');
      setAll(false);
      setSel([db.config.defaultDb]);
    }
  }, [open, db]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="계정 추가"
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!user}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ user: string; password: string }>(`/api/databases/${db.slug}/users`, { user, all, databases: sel });
                onClose();
                onCreated(r);
              } catch (e) {
                toast.error(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            만들기
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="계정 이름" hint="비밀번호는 자동으로 만듭니다">
          <input className="input mono" value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
        </Field>
        <Toggle checked={all} onChange={setAll} label="모든 DB 권한" />
        {!all && (
          <Field label="권한을 줄 DB">
            <div className="space-y-1">
              {schemas.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={sel.includes(s)} onChange={(e) => setSel(e.target.checked ? [...sel, s] : sel.filter((x) => x !== s))} className="accent-[var(--color-accent)]" />
                  <span className="mono">{s}</span>
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function NumField({ label, hint, value, onChange, suffix }: { label: string; hint?: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input className="input mono" inputMode="numeric" value={value} onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, '')) || 0)} />
        {suffix && <span className="shrink-0 text-sm text-muted">{suffix}</span>}
      </div>
    </Field>
  );
}

function Limits({ db, reload, running }: { db: DbDetailData; reload: () => void; running: boolean }) {
  const maria = db.type === 'mariadb';
  const [l, setL] = useState<any>(db.config.limits);
  useEffect(() => setL(db.config.limits), [db]);
  const { data } = useDbStatus(db.slug, running);
  const s = data?.status;
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const showWarnings = (w: string[]) => (w.length ? toast.info(`적용했습니다. 참고: ${w.join(' / ')}`) : toast.ok('바로 적용했습니다 (재시작 없음)'));
  const set = (k: string, v: unknown) => setL((x: any) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(l) !== JSON.stringify(db.config.limits);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            <Unlock size={16} className="text-accent-2" /> 연결 제한 한 번에 해제
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            {maria
              ? 'max_connections 10000, 계정별 제한 없음, max_connect_errors 최대(호스트 차단 방지), 패킷 1GB 로 올립니다. 파일 핸들(LimitNOFILE) 은 이미 1,048,576 입니다.'
              : 'maxclients 100000, 메모리 상한 없음, 유휴 타임아웃 없음으로 바꿉니다.'}{' '}
            재시작 없이 바로 적용됩니다.
          </p>
        </div>
        <Button
          variant="primary"
          icon={<Unlock size={15} />}
          loading={busy === 'unlimit'}
          onClick={async () => {
            if (!(await confirm({ title: '제한 해제', body: '연결 관련 제한을 크게 올립니다. 메모리가 부족한 서버라면 접속이 몰릴 때 느려질 수 있습니다.', confirm: '해제' }))) return;
            run('unlimit', async () => {
              const r = await api.post<{ warnings: string[] }>(`/api/databases/${db.slug}/unlimit`);
              showWarnings(r.warnings);
              reload();
            });
          }}
        >
          제한 해제
        </Button>
      </div>

      {maria && s && !s.error && (Number(s.max_user_connections) !== l.maxUserConnections || Number(s.max_connections) !== l.maxConnections) && !dirty && (
        <Notice tone="yellow" title="재시작해야 적용되는 값이 있습니다">
          {Number(s.max_user_connections) !== l.maxUserConnections && `max_user_connections: 현재 ${s.max_user_connections} → 설정 ${l.maxUserConnections}. `}
          {Number(s.max_connections) !== l.maxConnections && `max_connections: 현재 ${s.max_connections} → 설정 ${l.maxConnections} (파일 핸들 한도에 맞춰 줄었을 수 있음). `}
          MariaDB 는 시작할 때 0(무제한)이던 계정별 연결 제한을 실행 중에 바꿀 수 없습니다. 위의 재시작 버튼을 누르세요.
        </Notice>
      )}
      {s && !s.error && (
        <div>
          <div className="mb-2 text-sm font-semibold">현재 상태</div>
          <div className="grid gap-4 text-sm sm:grid-cols-4">
            {maria ? (
              <>
                <div>
                  <div className="text-xs text-muted">현재 연결</div>
                  <div className="mt-1 text-lg font-semibold">{s.Threads_connected}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">최대 사용 (재시작 후)</div>
                  <div className="mt-1 text-lg font-semibold">{s.Max_used_connections} / {s.max_connections}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">한도 초과로 거부</div>
                  <div className="mt-1 text-lg font-semibold">{s.Connection_errors_max_connections}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">파일 핸들 한도</div>
                  <div className="mt-1 text-lg font-semibold">{Number(s.open_files_limit).toLocaleString()}</div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="text-xs text-muted">현재 클라이언트</div>
                  <div className="mt-1 text-lg font-semibold">{s.connectedClients} / {s.maxClients}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">거부된 연결</div>
                  <div className="mt-1 text-lg font-semibold">{s.rejectedConnections}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">메모리</div>
                  <div className="mt-1 text-lg font-semibold">{bytes(s.usedMemory)} {s.maxMemory ? `/ ${bytes(s.maxMemory)}` : ''}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">AOF</div>
                  <div className="mt-1 text-lg font-semibold">{s.aofEnabled ? '켜짐' : '꺼짐'}</div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-semibold">세부 설정</div>
          {maria && (
            <Button size="sm" variant="ghost" icon={<Eraser size={14} />} loading={busy === 'flush'} onClick={() => run('flush', () => api.post(`/api/databases/${db.slug}/flush-hosts`), '차단된 호스트를 풀었습니다 (FLUSH HOSTS)')}>
              차단 호스트 풀기
            </Button>
          )}
        </div>
        {maria ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumField label="max_connections" hint="서버 전체 동시 연결" value={l.maxConnections} onChange={(v) => set('maxConnections', v)} />
            <NumField label="max_user_connections" hint="계정당 연결 (0 = 무제한)" value={l.maxUserConnections} onChange={(v) => set('maxUserConnections', v)} />
            <NumField label="max_connect_errors" hint="이만큼 실패하면 그 호스트 차단" value={l.maxConnectErrors} onChange={(v) => set('maxConnectErrors', v)} />
            <NumField label="wait_timeout" hint="유휴 연결 끊기" value={l.waitTimeout} onChange={(v) => set('waitTimeout', v)} suffix="초" />
            <NumField label="max_allowed_packet" value={l.maxAllowedPacketMB} onChange={(v) => set('maxAllowedPacketMB', v)} suffix="MB" />
            <NumField label="innodb_buffer_pool_size" hint="RAM 의 50~70% 권장" value={l.innodbBufferPoolMB} onChange={(v) => set('innodbBufferPoolMB', v)} suffix="MB" />
            <NumField label="table_open_cache" value={l.tableOpenCache} onChange={(v) => set('tableOpenCache', v)} />
            <NumField label="thread_cache_size" value={l.threadCacheSize} onChange={(v) => set('threadCacheSize', v)} />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <NumField label="maxclients" hint="동시 클라이언트" value={l.maxClients} onChange={(v) => set('maxClients', v)} />
            <NumField label="maxmemory" hint="0 = 제한 없음" value={l.maxMemoryMB} onChange={(v) => set('maxMemoryMB', v)} suffix="MB" />
            <Field label="maxmemory-policy" hint="가득 찼을 때">
              <select className="input" value={l.maxMemoryPolicy} onChange={(e) => set('maxMemoryPolicy', e.target.value)}>
                <option value="noeviction">noeviction (쓰기 거부)</option>
                <option value="allkeys-lru">allkeys-lru (캐시용 추천)</option>
                <option value="allkeys-lfu">allkeys-lfu</option>
                <option value="volatile-lru">volatile-lru (TTL 있는 키만)</option>
                <option value="volatile-ttl">volatile-ttl</option>
                <option value="allkeys-random">allkeys-random</option>
              </select>
            </Field>
            <NumField label="timeout" hint="유휴 연결 끊기 (0 = 안 끊음)" value={l.timeout} onChange={(v) => set('timeout', v)} suffix="초" />
            <Field label="save (RDB 스냅샷)" hint='"초 변경수" 쌍. 비우면 끔'>
              <input className="input mono" value={l.save} onChange={(e) => set('save', e.target.value)} />
            </Field>
            <div className="pt-6">
              <Toggle checked={l.appendonly} onChange={(v) => set('appendonly', v)} label="AOF (appendonly)" sub="매초 디스크 기록 → 재시작해도 데이터 유지" />
            </div>
          </div>
        )}
        <div className="mt-5 flex justify-end border-t border-line pt-4">
          <Button
            variant="primary"
            icon={<Save size={15} />}
            disabled={!dirty}
            loading={busy === 'save'}
            onClick={() =>
              run('save', async () => {
                const r = await api.put<{ warnings: string[] }>(`/api/databases/${db.slug}/limits`, l);
                showWarnings(r.warnings);
                reload();
              })
            }
          >
            저장 + 바로 적용
          </Button>
        </div>
      </div>
    </div>
  );
}

function DbBackups({ db, me, reload }: { db: DbDetailData; me: Me; reload: () => void }) {
  const { data, reload: reloadList } = useApi<Backup[]>(`/api/databases/${db.slug}/backups`, { refreshOn: ['backups'] });
  const [b, setB] = useState(db.config.backup);
  useEffect(() => setB(db.config.backup), [db]);
  const [job, setJob] = useState<number | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="space-y-5">
      <Card title="예약 백업">
        <div className="space-y-4">
          <Toggle checked={b.enabled} onChange={(v) => setB({ ...b, enabled: v })} label="자동 백업" sub={db.type === 'mariadb' ? 'mariadb-dump (--single-transaction, 서비스 중단 없음) + 계정/권한' : 'RDB 스냅샷 (redis-cli --rdb)'} />
          {b.enabled && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="주기">
                <select className="input" value={b.mode} onChange={(e) => setB({ ...b, mode: e.target.value as 'daily' | 'interval' })}>
                  <option value="daily">매일</option>
                  <option value="interval">N시간마다</option>
                </select>
              </Field>
              {b.mode === 'daily' ? (
                <Field label="시각 (서버 시간대)">
                  <input className="input mono" type="time" value={b.time} onChange={(e) => setB({ ...b, time: e.target.value })} />
                </Field>
              ) : (
                <Field label="간격 (시간)">
                  <input className="input mono w-24" inputMode="numeric" value={b.intervalHours} onChange={(e) => setB({ ...b, intervalHours: Number(e.target.value.replace(/\D/g, '')) || 6 })} />
                </Field>
              )}
              <Field label="보관 개수">
                <input className="input mono w-24" inputMode="numeric" value={b.keep} onChange={(e) => setB({ ...b, keep: Number(e.target.value.replace(/\D/g, '')) || 7 })} />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button variant="primary" icon={<Save size={15} />} disabled={JSON.stringify(b) === JSON.stringify(db.config.backup)} loading={busy === 'save'} onClick={() => run('save', () => api.patch(`/api/databases/${db.slug}`, { backup: b }).then(reload), '저장했습니다')}>
              저장
            </Button>
            <Button icon={<Upload size={15} />} loading={busy === 'now'} onClick={() => run('now', async () => setJob((await api.post<{ jobId: number }>('/api/backups', { kind: 'database', slug: db.slug })).jobId))}>
              지금 백업
            </Button>
          </div>
        </div>
      </Card>
      <BackupList list={data ?? []} me={me} reload={reloadList} />
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reloadList} />
    </div>
  );
}

function DbSettings({ db, reload }: { db: DbDetailData; reload: () => void }) {
  const [name, setName] = useState(db.name);
  const [port, setPort] = useState(String(db.config.port));
  const [bind, setBind] = useState(db.config.bind);
  const [res, setRes] = useState(db.config.resources);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <Fold icon={<SlidersHorizontal size={16} />} title="기본" defaultOpen>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="표시 이름">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="포트" hint="바꾸면 DB 를 재시작하고 연결된 앱 환경변수도 갱신합니다">
          <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        </Field>
        <Field label="접속 허용 주소">
          <select className="input" value={bind === 'local' || bind === 'all' ? bind : 'custom'} onChange={(e) => setBind(e.target.value === 'custom' ? '' : e.target.value)}>
            <option value="local">이 서버만 (127.0.0.1)</option>
            <option value="all">모든 인터페이스 (0.0.0.0)</option>
            <option value="custom">특정 IP (예: Tailscale IP)</option>
          </select>
          {bind !== 'local' && bind !== 'all' && <input className="input mono mt-2" placeholder="100.x.y.z" value={bind} onChange={(e) => setBind(e.target.value)} />}
        </Field>
      </div>
      <Disclosure label={<>리소스 제한 <span className="font-normal text-muted">{res.cpu || res.memoryMB ? [res.cpu ? `CPU ${res.cpu}코어` : '', res.memoryMB ? `메모리 ${res.memoryMB}MB` : ''].filter(Boolean).join(' · ') : '제한 없음'}</span></>}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="CPU (코어)">
            <input className="input mono" value={res.cpu ?? ''} onChange={(e) => setRes({ ...res, cpu: num(e.target.value) })} placeholder="제한 없음" />
          </Field>
          <Field label="메모리 (MB)" hint="버퍼 풀/maxmemory 보다 넉넉하게">
            <input className="input mono" value={res.memoryMB ?? ''} onChange={(e) => setRes({ ...res, memoryMB: num(e.target.value.replace(/\D/g, '')) })} placeholder="제한 없음" />
          </Field>
          <Field label="CPU 우선순위">
            <select className="input" value={res.cpuWeight ?? ''} onChange={(e) => setRes({ ...res, cpuWeight: num(e.target.value) })}>
              <option value="">보통 (100)</option>
              <option value="50">낮음 (50)</option>
              <option value="200">높음 (200)</option>
            </select>
          </Field>
        </div>
      </Disclosure>
      <div className="flex justify-end border-t border-line pt-4">
        <Button
          variant="primary"
          icon={<Save size={15} />}
          loading={busy === 'save'}
          onClick={async () => {
            const restart = Number(port) !== db.config.port || bind !== db.config.bind;
            if (restart && !(await confirm({ title: 'DB 재시작 필요', body: '포트/접속 주소를 바꾸면 DB 가 재시작됩니다. 연결된 앱도 재시작해야 새 주소를 씁니다.', confirm: '저장 + 재시작' }))) return;
            run('save', () => api.patch(`/api/databases/${db.slug}`, { name, port: Number(port), bind, resources: res }).then(reload), '저장했습니다');
          }}
        >
          저장
        </Button>
      </div>
    </Fold>
  );
}

function limitSummary(db: DbDetailData) {
  const l = db.config.limits;
  return 'maxConnections' in l ? `최대 연결 ${l.maxConnections.toLocaleString()} · 계정당 ${l.maxUserConnections || '무제한'}` : `최대 클라이언트 ${l.maxClients.toLocaleString()} · 메모리 ${l.maxMemoryMB ? `${l.maxMemoryMB}MB` : '제한 없음'}`;
}

function Danger({ db, me }: { db: DbDetailData; me: Me }) {
  const [open, setOpen] = useState(false);
  const [backup, setBackup] = useState(true);
  const ref = useRef(backup);
  ref.current = backup;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="font-medium text-bad">데이터베이스 삭제</div>
          <p className="mt-1 max-w-xl text-sm text-muted">인스턴스를 멈추고 데이터 폴더와 서비스를 지웁니다. 연결된 앱의 DB 환경변수도 빠집니다.</p>
        </div>
        <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setOpen(true)}>
          DB 삭제
        </Button>
      </div>
      <DangerDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${db.name} 삭제`}
        target={db.slug}
        needTotp={me.totpEnabled}
        items={[
          <>
            데이터 폴더 <code className="text-xs">{db.dataDir}</code> 의 모든 데이터
          </>,
          `systemd 서비스 hrone-db-${db.slug}`,
          ...(db.linkedApps.length ? [`연결된 앱 ${db.linkedApps.map((a) => a.name).join(', ')} 의 DB 환경변수`] : []),
        ]}
        options={<Toggle checked={backup} onChange={setBackup} label="삭제 전 최종 백업 만들기 (권장)" sub="서버 → 백업에 남습니다" />}
        onConfirm={async (auth) => {
          await api.post(`/api/databases/${db.slug}/terminate`, { ...auth, backup: ref.current });
          toast.ok('삭제했습니다');
          navigate('/databases');
        }}
      />
    </div>
  );
}


