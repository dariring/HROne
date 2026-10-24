import { ArrowRight, Check, GitBranch, Lock, Rocket, Sparkles, Unlock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, CopyField, Disclosure, Field, Notice, PageHeader, Segmented, Toggle, cx, toast } from '../components/ui';
import { api, errorText } from '../lib/api';
import { navigate, useTitle } from '../lib/router';
import { useApi } from '../lib/store';
import type { AppSummary, DbSummary } from './Dashboard';

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
type Mode = 'auto' | 'delay' | 'manual';

const NODE_VERSIONS = ['26', '24', '22', '20'];
const PY_VERSIONS = ['system', '3.14', '3.13', '3.12', '3.11', '3.10'];
const SLUG_RE = /^[a-z][a-z0-9-]{1,23}$/;

/** 영문/숫자만 남겨 앱 ID 후보를 만든다. 남는 게 없으면 '' */
function slugFrom(s: string) {
  return s
    .toLowerCase()
    .replace(/\.git$/, '')
    .split('/')
    .pop()!
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, 'app-$1')
    .slice(0, 24)
    .replace(/-+$/, '');
}

function repoName(url: string) {
  return url.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
}

const MODES: { value: Mode; label: string; desc: string }[] = [
  { value: 'auto', label: '바로 배포', desc: '푸시하면 곧바로 새 버전으로 바꿉니다.' },
  { value: 'delay', label: '잠시 뒤 배포', desc: '정한 시간만큼 기다렸다가 배포합니다. 그 사이 또 푸시하면 다시 기다립니다.' },
  { value: 'manual', label: '승인 후 배포', desc: '변경 내용을 보고 내가 승인해야 배포합니다.' },
];

export function AppNew() {
  useTitle('앱 추가');
  const { data: settings } = useApi<{ githubTokenSet: boolean; defaults: { pollIntervalSec: number } }>('/api/settings');
  const { data: dbs } = useApi<DbSummary[]>('/api/databases');
  const { data: apps } = useApi<AppSummary[]>('/api/apps');
  const { data: repos } = useApi<{ tokenSet: boolean; repos: { fullName: string; private: boolean; defaultBranch: string; description: string | null }[] }>('/api/github/repos');

  // 저장소
  const [repoUrl, setRepoUrl] = useState('');
  const [auth, setAuth] = useState<Auth>('none');
  const [gitToken, setGitToken] = useState('');
  const [key, setKey] = useState<{ keyId: string; publicKey: string } | null>(null);
  const [branch, setBranch] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [checkedRoot, setCheckedRoot] = useState('');
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [checkError, setCheckError] = useState('');
  const [checking, setChecking] = useState(false);
  // 기본
  const [name, setName] = useState('');
  const [startCmd, setStartCmd] = useState('');
  const [mode, setMode] = useState<Mode>('auto');
  const [delay, setDelay] = useState(5);
  const [delayUnit, setDelayUnit] = useState<'sec' | 'min'>('min');
  const [envText, setEnvText] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  // 고급
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [runtime, setRuntime] = useState<'node' | 'python'>('node');
  const [version, setVersion] = useState('24');
  const [installCmd, setInstallCmd] = useState('');
  const [buildCmd, setBuildCmd] = useState('');
  const [releaseCmd, setReleaseCmd] = useState('');
  const [port, setPort] = useState('');
  const [healthPath, setHealthPath] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [pollSec, setPollSec] = useState<number | null>(null);
  const [autostart, setAutostart] = useState(true);
  const [autoRollback, setAutoRollback] = useState(true);
  const [discord, setDiscord] = useState('');
  const [creating, setCreating] = useState(false);

  const det = inspect?.detection ?? null;
  const taken = useMemo(() => new Set((apps ?? []).map((a) => a.slug)), [apps]);

  // 앱 ID 는 이름(영문이면) → 저장소 이름 순으로 자동으로 정하고, 겹치면 숫자를 붙인다
  useEffect(() => {
    if (slugTouched) return;
    let base = slugFrom(name) || slugFrom(rootDir || repoUrl) || 'app';
    if (base.length < 2) base = `app-${base}`;
    let s = base;
    for (let i = 2; taken.has(s); i++) s = `${base.slice(0, 21)}-${i}`;
    setSlug(s);
  }, [name, repoUrl, rootDir, slugTouched, taken]);

  useEffect(() => {
    if (auth === 'deploykey' && !key) {
      api
        .post<{ keyId: string; publicKey: string }>('/api/repo/deploykey')
        .then(setKey)
        .catch((e) => toast.error(errorText(e)));
    }
  }, [auth, key]);

  const runInspect = (url: string, a: Auth, br: string) =>
    api.post<Inspect>('/api/repo/inspect', { repoUrl: url, auth: a, gitToken: a === 'token' ? gitToken || undefined : undefined, keyId: key?.keyId, branch: br || undefined, rootDir });

  const check = async (opts: { url?: string; auth?: Auth; branch?: string } = {}) => {
    const url = (opts.url ?? repoUrl).trim();
    if (!url) return;
    let a = opts.auth ?? auth;
    const br = opts.branch ?? branch;
    setChecking(true);
    setCheckError('');
    try {
      let r: Inspect;
      try {
        r = await runInspect(url, a, br);
      } catch (e) {
        // 공개로 안 열리면, 설정에 넣어 둔 GitHub 토큰으로 한 번 더 시도한다
        if (a !== 'none' || !settings?.githubTokenSet) throw e;
        a = 'token';
        r = await runInspect(url, a, br);
      }
      setAuth(a);
      setInspect(r);
      setCheckedRoot(rootDir);
      if (!br || r.error) setBranch(r.defaultBranch);
      if (r.error) {
        setCheckError(r.error);
        return;
      }
      const d = r.detection;
      if (d) {
        if (d.runtime) setRuntime(d.runtime);
        setVersion(d.runtimeVersion ?? (d.runtime === 'python' ? 'system' : '24'));
        setInstallCmd('');
        setBuildCmd(d.buildCmd);
        setStartCmd(d.startCmd);
        if (!name) setName(repoName(rootDir || url));
      }
    } catch (e) {
      setInspect(null);
      setCheckError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const poll = pollSec ?? settings?.defaults.pollIntervalSec ?? 60;

  const create = async () => {
    setCreating(true);
    try {
      const r = await api.post<{ app: { slug: string }; deployId: number }>('/api/apps', {
        slug,
        name: name || slug,
        gitToken: auth === 'token' ? gitToken || undefined : undefined,
        keyId: auth === 'deploykey' ? key?.keyId : undefined,
        discordWebhook: discord || undefined,
        envText,
        links: links.map((database) => ({ database })),
        config: {
          runtime,
          runtimeVersion: version,
          repoUrl: repoUrl.trim(),
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
          pollEnabled: poll > 0,
          pollIntervalSec: Math.max(15, poll),
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

  const needsAuth = /접근할 수 없습니다|배포 키|publickey/i.test(checkError);
  const stale = !!inspect && rootDir !== checkedRoot;
  const filteredRepos = useMemo(() => {
    const q = repoUrl.trim().toLowerCase();
    return (repos?.repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q)).slice(0, 6);
  }, [repos, repoUrl]);
  const blocker = !det
    ? null
    : stale
      ? '루트 폴더가 바뀌었습니다. 다시 확인하세요.'
      : !startCmd.trim()
        ? '시작 명령을 입력하세요.'
        : !SLUG_RE.test(slug)
          ? '고급 설정의 앱 ID 를 확인하세요 (영문 소문자로 시작, 2~24자).'
          : taken.has(slug)
            ? `앱 ID ${slug} 는 이미 있습니다. 고급 설정에서 바꾸세요.`
            : null;

  const pickRepo = (r: { fullName: string; private: boolean; defaultBranch: string }) => {
    const a: Auth = r.private ? 'token' : 'none';
    setRepoUrl(r.fullName);
    setBranch(r.defaultBranch);
    setAuth(a);
    setInspect(null);
    void check({ url: r.fullName, auth: a, branch: r.defaultBranch });
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="앱 추가" sub="저장소만 고르면 실행 방법은 알아서 찾아 줍니다" icon={<Rocket size={20} />} />

      <div className="space-y-5">
        <Card title={<StepTitle n={1} done={!!det} label="저장소" />}>
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                className="input mono"
                placeholder="owner/repo 또는 https://github.com/owner/repo"
                value={repoUrl}
                onChange={(e) => {
                  setRepoUrl(e.target.value);
                  setInspect(null);
                  setCheckError('');
                  setBranch('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && repoUrl.trim() && check()}
                spellCheck={false}
                autoFocus
              />
              <Button variant={det ? 'secondary' : 'primary'} icon={<ArrowRight size={15} />} onClick={() => check()} loading={checking} disabled={!repoUrl.trim() || (auth === 'deploykey' && !key)}>
                {det ? '다시 확인' : '확인'}
              </Button>
            </div>

            {repos?.tokenSet && filteredRepos.length > 0 && !inspect && !checking && (
              <div>
                <div className="mb-1.5 text-xs text-muted">내 GitHub 저장소</div>
                <div className="grid gap-1">
                  {filteredRepos.map((r) => (
                    <button
                      key={r.fullName}
                      type="button"
                      onClick={() => pickRepo(r)}
                      className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-3 cursor-pointer"
                    >
                      {r.private ? <Lock size={13} className="shrink-0 text-warn" /> : <Unlock size={13} className="shrink-0 text-muted" />}
                      <span className="mono shrink-0">{r.fullName}</span>
                      {r.description && <span className="truncate text-xs text-muted">{r.description}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {repos && !repos.tokenSet && !inspect && !checkError && (
              <p className="text-xs text-muted">
                공개 저장소는 주소만 넣으면 됩니다. 비공개 저장소는{' '}
                <a href="/settings?tab=connect" onClick={(e) => (e.preventDefault(), navigate('/settings?tab=connect'))} className="text-accent-2 hover:underline">
                  설정에 GitHub 토큰
                </a>
                을 넣어 두면 여기서 목록으로 고를 수 있습니다.
              </p>
            )}

            {checkError && (
              <div className="rounded-xl border border-bad/30 bg-bad/8 px-4 py-3 text-sm">
                <div className="text-bad">{checkError}</div>
                {needsAuth && (
                  <div className="mt-3 space-y-3 border-t border-bad/20 pt-3">
                    <div className="text-fg-2">비공개 저장소라면 접근 방법을 고르세요.</div>
                    <Segmented
                      value={auth === 'deploykey' ? 'deploykey' : 'token'}
                      onChange={(v) => setAuth(v)}
                      options={[
                        { value: 'token', label: 'GitHub 토큰' },
                        { value: 'deploykey', label: '배포 키 (SSH)' },
                      ]}
                    />
                    {auth !== 'deploykey' ? (
                      <Field hint="Fine-grained 토큰에 이 저장소의 Contents: Read 권한이면 충분합니다. 설정 → GitHub · 알림에 넣어 두면 다음부터는 입력하지 않아도 됩니다.">
                        <input className="input mono" type="password" placeholder="github_pat_..." value={gitToken} onChange={(e) => setGitToken(e.target.value)} autoComplete="off" />
                      </Field>
                    ) : (
                      <div className="space-y-2 text-fg-2">
                        <div>GitHub 저장소 → Settings → Deploy keys → Add deploy key 에 아래 공개키를 넣으세요 (쓰기 권한은 필요 없습니다).</div>
                        {key ? <CopyField value={key.publicKey} /> : <span className="text-muted">키 만드는 중...</span>}
                      </div>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      loading={checking}
                      disabled={auth === 'deploykey' ? !key : !gitToken && !settings?.githubTokenSet}
                      onClick={() => check({ auth: auth === 'deploykey' ? 'deploykey' : 'token' })}
                    >
                      이 방법으로 다시 확인
                    </Button>
                  </div>
                )}
              </div>
            )}

            {det && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Check size={16} className="text-ok" />
                <span className="text-fg-2">
                  <span className="mono">{branch || inspect?.defaultBranch}</span> 브랜치
                </span>
                {det.runtime ? <Badge tone="green">{det.runtime === 'node' ? 'Node.js' : 'Python'} {det.runtimeVersion ?? ''}</Badge> : <Badge tone="red">런타임을 찾지 못함</Badge>}
                {det.packageManager && <Badge>{det.packageManager}</Badge>}
                {auth !== 'none' && <Badge tone="yellow">{auth === 'token' ? '토큰으로 접근' : '배포 키로 접근'}</Badge>}
              </div>
            )}
            {det?.notes.map((n, i) => (
              <div key={i} className="text-xs text-warn">
                • {n}
              </div>
            ))}
          </div>
        </Card>

        {det && (
          <Card title={<StepTitle n={2} done={false} label="확인하고 배포" />}>
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="이름">
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="내 디스코드 봇" />
                </Field>
                <Field label="시작 명령" hint="자동으로 찾은 값입니다. 앱은 PORT 환경변수의 포트로 열면 됩니다.">
                  <input className="input mono" value={startCmd} onChange={(e) => setStartCmd(e.target.value)} placeholder={runtime === 'node' ? 'npm start' : 'python main.py'} />
                </Field>
              </div>

              <Field label="GitHub 에 푸시하면">
                <div className="grid gap-2 sm:grid-cols-3">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setMode(m.value)}
                      className={cx('rounded-xl border px-3 py-2.5 text-left transition-colors cursor-pointer', mode === m.value ? 'border-accent bg-accent/10' : 'border-line-2 hover:border-muted')}
                    >
                      <div className="text-sm font-semibold">{m.label}</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-muted">{m.desc}</div>
                    </button>
                  ))}
                </div>
              </Field>
              {mode === 'delay' && (
                <div className="flex items-center gap-2">
                  <input className="input mono w-24" inputMode="numeric" value={delay} onChange={(e) => setDelay(Number(e.target.value.replace(/\D/g, '')) || 1)} />
                  <Segmented
                    value={delayUnit}
                    onChange={setDelayUnit}
                    options={[
                      { value: 'sec', label: '초' },
                      { value: 'min', label: '분' },
                    ]}
                  />
                  <span className="text-sm text-muted">뒤에 배포</span>
                </div>
              )}

              <div className="space-y-4 border-t border-line pt-4">
                <Disclosure label={<>환경변수 <span className="font-normal text-muted">{envText.trim() ? `${envText.split('\n').filter((l) => /^\s*[\w.]+\s*=/.test(l)).length}개` : '(선택)'}</span></>}>
                  <textarea className="input mono min-h-[140px] text-[13px]" value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'# .env 내용을 그대로 붙여넣으세요\nDISCORD_TOKEN=...\nAPI_KEY=...'} spellCheck={false} />
                </Disclosure>

                {(dbs ?? []).length > 0 && (
                  <Disclosure label={<>데이터베이스 연결 <span className="font-normal text-muted">{links.length ? `${links.length}개` : '(선택)'}</span></>}>
                    <div className="space-y-1">
                      {dbs!.map((d) => (
                        <label key={d.slug} className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                          <input type="checkbox" checked={links.includes(d.slug)} onChange={(e) => setLinks(e.target.checked ? [...links, d.slug] : links.filter((x) => x !== d.slug))} className="accent-[var(--color-accent)]" />
                          <span className="text-sm font-medium">{d.name}</span>
                          <Badge>{d.type === 'mariadb' ? 'MariaDB' : 'Redis'}</Badge>
                          <span className="text-xs text-muted">{d.type === 'mariadb' ? 'DATABASE_URL, DB_HOST ...' : 'REDIS_URL ...'} 자동으로 들어감</span>
                        </label>
                      ))}
                    </div>
                  </Disclosure>
                )}

                <Disclosure label="고급 설정">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="브랜치">
                      <select
                        className="input"
                        value={branch || inspect?.defaultBranch}
                        onChange={(e) => {
                          setBranch(e.target.value);
                          void check({ branch: e.target.value });
                        }}
                      >
                        {inspect!.branches.map((b) => (
                          <option key={b.name} value={b.name}>
                            {b.name}
                            {b.name === inspect!.defaultBranch ? ' (기본)' : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="루트 폴더" hint="모노레포라면 앱이 있는 하위 폴더 (예: apps/api)">
                      <div className="flex gap-2">
                        <input className="input mono" placeholder="/" value={rootDir} onChange={(e) => setRootDir(e.target.value)} />
                        {stale && (
                          <Button size="sm" className="h-auto" icon={<GitBranch size={14} />} loading={checking} onClick={() => check()}>
                            다시 확인
                          </Button>
                        )}
                      </div>
                    </Field>
                    <Field label="앱 ID" hint="폴더·서비스 이름에 쓰이며 나중에 바꿀 수 없습니다">
                      <input
                        className="input mono"
                        value={slug}
                        onChange={(e) => {
                          setSlug(e.target.value.toLowerCase());
                          setSlugTouched(true);
                        }}
                      />
                    </Field>
                    <Field label="런타임">
                      <div className="flex gap-2">
                        <Segmented
                          value={runtime}
                          onChange={(v) => {
                            setRuntime(v);
                            setVersion(v === 'node' ? '24' : 'system');
                          }}
                          options={[
                            { value: 'node', label: 'Node.js' },
                            { value: 'python', label: 'Python' },
                          ]}
                        />
                        <input className="input mono w-24" list="versions" value={version} onChange={(e) => setVersion(e.target.value)} title="버전 (없으면 자동 설치)" />
                        <datalist id="versions">
                          {(runtime === 'node' ? NODE_VERSIONS : PY_VERSIONS).map((v) => (
                            <option key={v} value={v} />
                          ))}
                        </datalist>
                      </div>
                    </Field>
                  </div>
                  <Field label="설치 명령" hint={`비워 두면 자동: ${det.installCmd || (runtime === 'node' ? 'lockfile 기준 npm / pnpm / yarn' : 'uv pip install -r requirements.txt')}`}>
                    <input className="input mono" value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} placeholder="(자동)" />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="빌드 명령">
                      <input className="input mono" value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} placeholder="없음" />
                    </Field>
                    <Field label="배포 직전 명령" hint="DB 마이그레이션 등">
                      <input className="input mono" value={releaseCmd} onChange={(e) => setReleaseCmd(e.target.value)} placeholder="없음" />
                    </Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="포트" hint="비우면 자동 배정">
                      <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="자동" />
                    </Field>
                    <Field label="상태 확인 경로" hint="배포 후 200 응답 확인">
                      <input className="input mono" value={healthPath} onChange={(e) => setHealthPath(e.target.value)} placeholder="/health" />
                    </Field>
                    <Field label="새 커밋 확인 주기 (초)" hint="0 = 끄기 (웹후크만)">
                      <input className="input mono" inputMode="numeric" value={poll} onChange={(e) => setPollSec(Number(e.target.value.replace(/\D/g, '')))} />
                    </Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="공개 주소" hint="cloudflared 로 연결한 도메인 (링크 표시용)">
                      <input className="input" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://app.example.com" />
                    </Field>
                    <Field label="디스코드 웹후크" hint="비우면 설정의 기본 웹후크">
                      <input className="input mono" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
                    </Field>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Toggle checked={autoRollback} onChange={setAutoRollback} label="실패하면 이전 버전으로 되돌리기" />
                    <Toggle checked={autostart} onChange={setAutostart} label="서버 재부팅 시 자동 시작" />
                  </div>
                </Disclosure>
              </div>

              {blocker && <Notice tone="yellow">{blocker}</Notice>}
              <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
                <span className="text-xs text-muted">
                  ID <span className="mono text-fg-2">{slug}</span> · {runtime === 'node' ? 'Node.js' : 'Python'} {version}
                </span>
                <Button variant="primary" size="lg" icon={<Rocket size={16} />} onClick={create} loading={creating} disabled={!!blocker}>
                  배포하기
                </Button>
              </div>
            </div>
          </Card>
        )}

        {!det && (
          <div className="card flex items-center gap-3 border-dashed px-5 py-4 text-sm text-muted">
            <Sparkles size={16} className="shrink-0" />
            저장소를 확인하면 런타임, 설치·시작 명령을 자동으로 채워 드립니다.
          </div>
        )}
      </div>
    </div>
  );
}

function StepTitle({ n, done, label }: { n: number; done: boolean; label: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-ok/20 text-ok' : 'bg-accent text-white')}>{done ? <Check size={13} /> : n}</span>
      {label}
    </span>
  );
}
