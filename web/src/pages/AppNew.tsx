import { ArrowLeft, ArrowRight, Check, GitBranch, KeyRound, Lock, Rocket, Search, Sparkles, Unlock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, CopyField, Field, Notice, PageHeader, Segmented, Toggle, cx, toast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { navigate, useTitle } from '../lib/router';
import { useApi } from '../lib/store';
import type { DbSummary } from './Dashboard';

interface Detection {
  runtime: 'node' | 'python' | null;
  runtimeVersion: string | null;
  packageManager: string | null;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  notes: string[];
  files: string[];
}

interface Inspect {
  url: string;
  branches: { name: string; sha: string }[];
  defaultBranch: string;
  detection: Detection | null;
  error?: string;
}

type Auth = 'none' | 'token' | 'deploykey';

const NODE_VERSIONS = ['26', '24', '22', '20'];
const PY_VERSIONS = ['system', '3.14', '3.13', '3.12', '3.11', '3.10'];

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/\.git$/, '')
      .split('/')
      .pop()!
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^(\d)/, 'app-$1')
      .slice(0, 24)
      .replace(/-+$/, '') || 'app'
  );
}

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className={cx('flex items-center gap-2 text-sm', active ? 'text-fg' : 'text-muted')}>
      <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-ok/20 text-ok' : active ? 'bg-accent text-white' : 'bg-surface-3')}>
        {done ? <Check size={13} /> : n}
      </span>
      <span className="hidden font-medium sm:inline">{label}</span>
    </div>
  );
}

export function AppNew() {
  useTitle('앱 추가');
  const { data: settings } = useApi<{ githubTokenSet: boolean }>('/api/settings');
  const { data: dbs } = useApi<DbSummary[]>('/api/databases');
  const { data: repos } = useApi<{ tokenSet: boolean; repos: { fullName: string; private: boolean; defaultBranch: string; description: string | null }[] }>('/api/github/repos');

  const [step, setStep] = useState(1);
  // 1. 저장소
  const [repoUrl, setRepoUrl] = useState('');
  const [auth, setAuth] = useState<Auth>('none');
  const [gitToken, setGitToken] = useState('');
  const [key, setKey] = useState<{ keyId: string; publicKey: string } | null>(null);
  const [rootDir, setRootDir] = useState('');
  const [branch, setBranch] = useState('');
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [checking, setChecking] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  // 2. 실행
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [runtime, setRuntime] = useState<'node' | 'python'>('node');
  const [version, setVersion] = useState('24');
  const [installCmd, setInstallCmd] = useState('');
  const [buildCmd, setBuildCmd] = useState('');
  const [startCmd, setStartCmd] = useState('');
  const [releaseCmd, setReleaseCmd] = useState('');
  const [port, setPort] = useState('');
  const [healthPath, setHealthPath] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  // 3. 배포
  const [mode, setMode] = useState<'auto' | 'delay' | 'manual'>('auto');
  const [delay, setDelay] = useState(5);
  const [delayUnit, setDelayUnit] = useState<'sec' | 'min'>('min');
  const [pollSec, setPollSec] = useState(60);
  const [autostart, setAutostart] = useState(true);
  const [autoRollback, setAutoRollback] = useState(true);
  const [discord, setDiscord] = useState('');
  const [envText, setEnvText] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (auth === 'deploykey' && !key) {
      api
        .post<{ keyId: string; publicKey: string }>('/api/repo/deploykey')
        .then(setKey)
        .catch((e) => toast.error(e.message));
    }
  }, [auth, key]);

  useEffect(() => {
    if (!slugTouched && repoUrl) setSlug(slugify(rootDir ? rootDir : repoUrl));
  }, [repoUrl, rootDir, slugTouched]);

  const check = async () => {
    setChecking(true);
    setInspect(null);
    try {
      const r = await api.post<Inspect>('/api/repo/inspect', { repoUrl, auth, gitToken: gitToken || undefined, keyId: key?.keyId, branch: branch || undefined, rootDir });
      setInspect(r);
      if (!branch) setBranch(r.defaultBranch);
      if (r.error) toast.error(r.error);
      const d = r.detection;
      if (d) {
        if (d.runtime) setRuntime(d.runtime);
        setVersion(d.runtimeVersion ?? (d.runtime === 'python' ? 'system' : '24'));
        setInstallCmd('');
        setBuildCmd(d.buildCmd);
        setStartCmd(d.startCmd);
        if (!name) setName(slugify(rootDir || repoUrl));
      }
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const det = inspect?.detection;
  const filteredRepos = useMemo(() => (repos?.repos ?? []).filter((r) => !repoFilter || r.fullName.toLowerCase().includes(repoFilter.toLowerCase())).slice(0, 8), [repos, repoFilter]);

  const create = async () => {
    setCreating(true);
    try {
      const r = await api.post<{ app: { slug: string }; deployId: number }>('/api/apps', {
        slug,
        name: name || slug,
        gitToken: auth === 'token' ? gitToken : undefined,
        keyId: auth === 'deploykey' ? key?.keyId : undefined,
        discordWebhook: discord || undefined,
        envText,
        links: links.map((database) => ({ database })),
        config: {
          runtime,
          runtimeVersion: version,
          repoUrl,
          branch: branch || inspect?.defaultBranch || 'main',
          auth,
          rootDir,
          installCmd,
          buildCmd,
          startCmd,
          releaseCmd,
          port: port ? Number(port) : null,
          healthPath,
          publicUrl,
          deployMode: mode,
          deployDelaySec: delayUnit === 'min' ? delay * 60 : delay,
          pollEnabled: pollSec > 0,
          pollIntervalSec: Math.max(15, pollSec),
          autostart,
          autoRollback,
        },
      });
      toast.ok('앱을 만들었습니다. 첫 배포를 시작합니다.');
      navigate(`/apps/${r.app.slug}?tab=deploys&deploy=${r.deployId}`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => window.scrollTo(0, 0), [step]);

  const canNext1 = !!inspect && !inspect.error && !!det;
  const canNext2 = /^[a-z][a-z0-9-]{1,23}$/.test(slug) && !!startCmd.trim();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="앱 추가" sub="저장소를 연결하면 푸시할 때마다 자동으로 배포됩니다" icon={<Rocket size={20} />} />
      <div className="mb-6 flex items-center gap-3">
        <Step n={1} label="저장소" active={step === 1} done={step > 1} />
        <div className="h-px flex-1 bg-line" />
        <Step n={2} label="실행 설정" active={step === 2} done={step > 2} />
        <div className="h-px flex-1 bg-line" />
        <Step n={3} label="배포 · 환경변수" active={step === 3} done={false} />
      </div>

      {step === 1 && (
        <div className="space-y-5">
          <Card title="저장소">
            <div className="space-y-5">
              <Field label="접근 방식">
                <div className="grid gap-2 sm:grid-cols-3">
                  {(
                    [
                      ['none', <Unlock size={16} />, '공개 저장소', '인증 없음'],
                      ['token', <Lock size={16} />, 'GitHub 토큰', settings?.githubTokenSet ? '전역 토큰 사용 가능' : '비공개 저장소'],
                      ['deploykey', <KeyRound size={16} />, '배포 키 (SSH)', '저장소 하나만 읽기 전용'],
                    ] as const
                  ).map(([v, icon, label, sub]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => {
                        setAuth(v);
                        setInspect(null);
                      }}
                      className={cx('rounded-xl border p-3 text-left transition-colors cursor-pointer', auth === v ? 'border-accent bg-accent/10' : 'border-line-2 hover:border-muted')}
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        {icon}
                        {label}
                      </div>
                      <div className="mt-1 text-xs text-muted">{sub}</div>
                    </button>
                  ))}
                </div>
              </Field>

              {auth === 'token' && (
                <Field
                  label="GitHub 토큰 (선택)"
                  hint={settings?.githubTokenSet ? '비워 두면 설정 → GitHub 의 전역 토큰을 씁니다.' : 'Fine-grained 토큰에 해당 저장소 Contents: Read 권한이면 충분합니다. 설정 → GitHub 에 전역 토큰을 넣어 두면 매번 입력하지 않아도 됩니다.'}
                >
                  <input className="input mono" type="password" placeholder="github_pat_..." value={gitToken} onChange={(e) => setGitToken(e.target.value)} autoComplete="off" />
                </Field>
              )}

              {auth === 'deploykey' && (
                <Notice tone="purple" title="이 공개키를 저장소에 등록하세요" icon={<KeyRound size={16} />}>
                  <div className="mt-2 space-y-2">
                    <div>GitHub 저장소 → Settings → Deploy keys → Add deploy key (Allow write access 는 체크하지 마세요)</div>
                    {key ? <CopyField value={key.publicKey} /> : <span className="text-muted">키 생성 중...</span>}
                  </div>
                </Notice>
              )}

              <Field label="저장소 주소" hint="owner/repo, https://github.com/owner/repo, git@github.com:owner/repo.git 모두 됩니다">
                <input
                  className="input mono"
                  placeholder="owner/repo"
                  value={repoUrl}
                  onChange={(e) => {
                    setRepoUrl(e.target.value);
                    setInspect(null);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && repoUrl && check()}
                  spellCheck={false}
                />
              </Field>

              {repos?.tokenSet && repos.repos.length > 0 && !inspect && (
                <div className="rounded-xl border border-line bg-surface-2 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Search size={14} className="text-muted" />
                    <input className="flex-1 bg-transparent text-sm outline-none" placeholder="내 GitHub 저장소에서 고르기" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} />
                  </div>
                  <div className="grid gap-1">
                    {filteredRepos.map((r) => (
                      <button
                        key={r.fullName}
                        type="button"
                        onClick={() => {
                          setRepoUrl(r.fullName);
                          setBranch(r.defaultBranch);
                          if (r.private) setAuth('token');
                        }}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-3 cursor-pointer"
                      >
                        {r.private ? <Lock size={13} className="text-warn" /> : <Unlock size={13} className="text-muted" />}
                        <span className="mono">{r.fullName}</span>
                        {r.description && <span className="truncate text-xs text-muted">{r.description}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="브랜치" hint={inspect ? `${inspect.branches.length}개 브랜치` : '확인 후 선택할 수 있습니다'}>
                  {inspect?.branches.length ? (
                    <select
                      className="input"
                      value={branch}
                      onChange={(e) => {
                        setBranch(e.target.value);
                        setInspect({ ...inspect, detection: null });
                      }}
                    >
                      {inspect.branches.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.name}
                          {b.name === inspect.defaultBranch ? ' (기본)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className="input mono" placeholder="기본 브랜치" value={branch} onChange={(e) => setBranch(e.target.value)} />
                  )}
                </Field>
                <Field label="루트 폴더 (선택)" hint="모노레포라면 앱이 있는 하위 폴더 (예: apps/api)">
                  <input
                    className="input mono"
                    placeholder="/"
                    value={rootDir}
                    onChange={(e) => {
                      setRootDir(e.target.value);
                      setInspect(inspect ? { ...inspect, detection: null } : null);
                    }}
                  />
                </Field>
              </div>

              <Button variant="primary" icon={<GitBranch size={15} />} onClick={check} loading={checking} disabled={!repoUrl || (auth === 'deploykey' && !key)}>
                {inspect && !det ? '다시 확인' : '저장소 확인'}
              </Button>
            </div>
          </Card>

          {det && (
            <Card title={<span className="flex items-center gap-2"><Sparkles size={16} className="text-accent-2" /> 자동 감지 결과</span>}>
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  {det.runtime ? <Badge tone="green">{det.runtime === 'node' ? 'Node.js' : 'Python'}</Badge> : <Badge tone="red">런타임 미감지</Badge>}
                  {det.packageManager && <Badge>{det.packageManager}</Badge>}
                  {det.runtimeVersion && <Badge tone="blue">버전 {det.runtimeVersion}</Badge>}
                </div>
                <div className="mono rounded-lg bg-bg p-3 text-xs leading-relaxed text-fg-2">
                  <div>
                    <span className="text-muted">설치 </span>
                    {det.installCmd || '-'}
                  </div>
                  <div>
                    <span className="text-muted">빌드 </span>
                    {det.buildCmd || '-'}
                  </div>
                  <div>
                    <span className="text-muted">시작 </span>
                    {det.startCmd || '-'}
                  </div>
                </div>
                {det.notes.map((n, i) => (
                  <div key={i} className="text-xs text-warn">
                    • {n}
                  </div>
                ))}
                <div className="text-xs text-muted">파일: {det.files.slice(0, 20).join(', ')}</div>
              </div>
            </Card>
          )}

          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setStep(2)} disabled={!canNext1} icon={<ArrowRight size={15} />}>
              다음
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <Card title="기본 정보">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="이름">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="내 디스코드 봇" />
              </Field>
              <Field label="앱 ID" hint="영문 소문자/숫자/-, 2~24자. 폴더/서비스 이름에 쓰이며 나중에 못 바꿉니다">
                <input
                  className="input mono"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value.toLowerCase());
                    setSlugTouched(true);
                  }}
                />
              </Field>
            </div>
          </Card>
          <Card title="런타임 · 명령">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="런타임">
                  <Segmented
                    value={runtime}
                    onChange={(v) => {
                      setRuntime(v);
                      setVersion(v === 'node' ? '24' : 'system');
                    }}
                    options={[
                      { value: 'node', label: 'Node.js' },
                      { value: 'python', label: 'Python 3' },
                    ]}
                  />
                </Field>
                <Field label="버전" hint={runtime === 'python' ? 'system = 서버의 python3, 그 외는 uv 로 자동 설치' : '없으면 nodejs.org 에서 자동 설치'}>
                  <input className="input mono" list="versions" value={version} onChange={(e) => setVersion(e.target.value)} />
                  <datalist id="versions">
                    {(runtime === 'node' ? NODE_VERSIONS : PY_VERSIONS).map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </Field>
              </div>
              <Field label="설치 명령" hint={`비워 두면 자동: ${det?.installCmd || (runtime === 'node' ? 'npm ci / pnpm / yarn (lockfile 기준)' : 'uv pip install -r requirements.txt')}. 의존성 파일이 바뀔 때만 실행됩니다.`}>
                <input className="input mono" value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} placeholder="(자동)" />
              </Field>
              <Field label="빌드 명령 (선택)">
                <input className="input mono" value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} placeholder="npm run build" />
              </Field>
              <Field label="시작 명령" hint="PORT, HOST(=127.0.0.1) 환경변수가 주어집니다. 앱이 127.0.0.1:$PORT 로 열리게 하세요.">
                <input className="input mono" value={startCmd} onChange={(e) => setStartCmd(e.target.value)} placeholder={runtime === 'node' ? 'npm start' : 'python main.py'} />
              </Field>
              <Field label="릴리스 명령 (선택)" hint="빌드 후, 재시작 전에 실행 (DB 마이그레이션 등)">
                <input className="input mono" value={releaseCmd} onChange={(e) => setReleaseCmd(e.target.value)} placeholder="npx prisma migrate deploy" />
              </Field>
            </div>
          </Card>
          <Card title="네트워크">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="포트" hint="비우면 3000번대에서 자동 배정">
                <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="자동" />
              </Field>
              <Field label="헬스체크 경로 (선택)" hint="배포 후 200 응답을 확인">
                <input className="input mono" value={healthPath} onChange={(e) => setHealthPath(e.target.value)} placeholder="/health" />
              </Field>
              <Field label="공개 주소 (선택)" hint="cloudflared 로 연결한 도메인">
                <input className="input" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://app.example.com" />
              </Field>
            </div>
          </Card>
          <div className="flex justify-between">
            <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => setStep(1)}>
              이전
            </Button>
            <Button variant="primary" onClick={() => setStep(3)} disabled={!canNext2} icon={<ArrowRight size={15} />}>
              다음
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-5">
          <Card title="푸시가 올라오면">
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    ['auto', '즉시 적용', '새 커밋을 감지하면 바로 배포'],
                    ['delay', '일정 시간 뒤 적용', '기다리는 동안 취소/즉시 적용 가능. 그 사이 또 푸시하면 타이머가 다시 시작'],
                    ['manual', '검토 후 적용', '변경 내용을 보고 승인해야 배포'],
                  ] as const
                ).map(([v, label, sub]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMode(v)}
                    className={cx('rounded-xl border p-3 text-left transition-colors cursor-pointer', mode === v ? 'border-accent bg-accent/10' : 'border-line-2 hover:border-muted')}
                  >
                    <div className="text-sm font-semibold">{label}</div>
                    <div className="mt-1 text-xs leading-relaxed text-muted">{sub}</div>
                  </button>
                ))}
              </div>
              {mode === 'delay' && (
                <div className="flex items-center gap-2">
                  <input className="input mono w-28" inputMode="numeric" value={delay} onChange={(e) => setDelay(Number(e.target.value.replace(/\D/g, '')) || 1)} />
                  <Segmented
                    value={delayUnit}
                    onChange={setDelayUnit}
                    options={[
                      { value: 'sec', label: '초' },
                      { value: 'min', label: '분' },
                    ]}
                  />
                  <span className="text-sm text-muted">뒤에 적용</span>
                </div>
              )}
              <Field label="원격 확인 주기" hint="폴링 주기(초). GitHub 웹후크를 연결하면 푸시 즉시 감지됩니다 (앱 설정에서 주소 확인). 0 = 폴링 끔">
                <input className="input mono w-32" inputMode="numeric" value={pollSec} onChange={(e) => setPollSec(Number(e.target.value.replace(/\D/g, '')))} />
              </Field>
              <Toggle checked={autoRollback} onChange={setAutoRollback} label="실패하면 자동 롤백" sub="새 버전이 시작에 실패하거나 헬스체크를 통과하지 못하면 이전 버전으로 되돌립니다" />
              <Toggle checked={autostart} onChange={setAutostart} label="서버 재부팅 시 자동 시작" />
              <Field label="디스코드 웹후크 (선택)" hint="비우면 설정의 전역 웹후크로 알림이 갑니다">
                <input className="input mono" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
              </Field>
            </div>
          </Card>
          <Card title="환경변수 (선택)">
            <textarea className="input mono min-h-[140px] text-[13px]" value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'# .env 내용을 붙여넣으세요\nDISCORD_TOKEN=...\nAPI_KEY=...'} spellCheck={false} />
          </Card>
          {(dbs ?? []).length > 0 && (
            <Card title="데이터베이스 연결 (선택)">
              <div className="space-y-2">
                {dbs!.map((d) => (
                  <label key={d.slug} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                    <input type="checkbox" checked={links.includes(d.slug)} onChange={(e) => setLinks(e.target.checked ? [...links, d.slug] : links.filter((x) => x !== d.slug))} className="accent-[var(--color-accent)]" />
                    <span className="text-sm font-medium">{d.name}</span>
                    <Badge>{d.type === 'mariadb' ? 'MariaDB' : 'Redis'}</Badge>
                    <span className="text-xs text-muted">{d.type === 'mariadb' ? 'DB_HOST, DB_USER, DATABASE_URL ...' : 'REDIS_URL, REDIS_HOST ...'}</span>
                  </label>
                ))}
              </div>
              <div className="hint">같은 종류를 여러 개 연결하려면 앱을 만든 뒤 "DB 연결" 탭에서 접두사를 지정하세요.</div>
            </Card>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => setStep(2)}>
              이전
            </Button>
            <Button variant="primary" size="lg" icon={<Rocket size={16} />} onClick={create} loading={creating}>
              만들고 배포
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
