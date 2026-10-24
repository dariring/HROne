import { Archive, Bell, Download, Gauge, GitBranch, HardDrive, KeyRound, Play, Rocket, RotateCcw, Save, ShieldAlert, SlidersHorizontal, Trash2, Upload, Webhook } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DangerDialog, JobDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { modeText } from '../components/shared';
import { Button, CopyField, Field, Fold, Notice, Segmented, Toggle, toast, useAction, useConfirm } from '../components/ui';
import { api, errorText } from '../lib/api';
import { navigate } from '../lib/router';
import { useApi } from '../lib/store';
import type { AppConfig, AppDetailData } from './AppDetail';
import { BackupList, type Backup } from './Backups';

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

function resourceSummary(r: AppConfig['resources']) {
  const parts = [r.cpu ? `CPU ${r.cpu}코어` : '', r.memoryMB ? `메모리 ${r.memoryMB}MB` : '', r.tasks ? `프로세스 ${r.tasks}개` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '제한 없음';
}

export function AppSettings({ app, me, reload }: { app: AppDetailData; me: Me; reload: () => void }) {
  const [c, setC] = useState<AppConfig>(app.config);
  const [name, setName] = useState(app.name);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  const { busy, run } = useAction();
  const { data: secrets, reload: reloadSecrets } = useApi<{ webhookSecret: string; discordWebhook: string; gitTokenSet: boolean }>(`/api/apps/${app.slug}/secrets`);
  const { data: settings } = useApi<{ panel: { baseUrl: string } }>('/api/settings');
  const [discord, setDiscord] = useState('');
  const [token, setToken] = useState('');
  const [deployKey, setDeployKey] = useState(app.deployKey);
  useEffect(() => setDiscord(secrets?.discordWebhook ?? ''), [secrets]);
  useEffect(() => {
    setC(app.config);
    setName(app.name);
    setDeployKey(app.deployKey);
  }, [app]);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const dirty = useMemo(() => JSON.stringify(c) !== JSON.stringify(app.config) || name !== app.name, [c, app, name]);
  const [unit, setUnit] = useState<'sec' | 'min'>(app.config.deployDelaySec >= 60 && app.config.deployDelaySec % 60 === 0 ? 'min' : 'sec');
  const hookUrl = `${settings?.panel.baseUrl || location.origin}${app.webhookPath}`;
  const repoShort = c.repoUrl.replace(/^https?:\/\/(github\.com\/)?|^git@github\.com:|\.git$/g, '');
  const notifyOn = (Object.entries(c.notify) as [string, boolean][]).filter(([, v]) => v).length;

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.patch<{ redeploy: boolean }>(`/api/apps/${app.slug}`, { name, config: c });
      toast.ok('저장했습니다');
      reload();
      if (r.redeploy && (await confirm({ title: '다시 배포할까요?', body: '저장소/브랜치/명령/런타임이 바뀌었습니다. 새 설정으로 배포해야 반영됩니다.', confirm: '지금 배포' }))) {
        const d = await api.post<{ id: number }>(`/api/apps/${app.slug}/deploy`, { trigger: 'config' });
        navigate(`/apps/${app.slug}?tab=deploys&deploy=${d.id}`);
      }
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 pb-20">
      {c.runAsRoot && (
        <Notice tone="red" title="root 로 실행하도록 설정되어 있습니다" icon={<ShieldAlert size={16} />}>
          앱의 취약점이 서버 전체 장악으로 이어질 수 있습니다. 꼭 필요할 때만 쓰세요 (빌드 · 실행에서 끌 수 있습니다).
        </Notice>
      )}

      <Fold icon={<SlidersHorizontal size={16} />} title="기본" defaultOpen>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="이름">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="시작 명령" hint="환경변수 PORT 와 HOST=127.0.0.1 이 주어집니다">
            <input className="input mono" value={c.startCmd} onChange={(e) => set('startCmd', e.target.value)} />
          </Field>
          <Field label="포트" hint="127.0.0.1 에서만 열립니다">
            <input className="input mono" inputMode="numeric" value={c.port ?? ''} onChange={(e) => set('port', numOrNull(e.target.value.replace(/\D/g, '')))} placeholder="없음" />
          </Field>
          <Field label="공개 주소" hint="cloudflared 로 연결한 도메인 (링크 표시용)">
            <input className="input" value={c.publicUrl} onChange={(e) => set('publicUrl', e.target.value)} placeholder="https://app.example.com" />
          </Field>
        </div>
        <Field label="GitHub 에 푸시하면">
          <Segmented
            value={c.deployMode}
            onChange={(v) => set('deployMode', v)}
            options={[
              { value: 'auto', label: '바로 배포' },
              { value: 'delay', label: '잠시 뒤 배포' },
              { value: 'manual', label: '승인 후 배포' },
            ]}
          />
        </Field>
        {c.deployMode === 'delay' && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input mono w-24"
              inputMode="numeric"
              value={unit === 'min' ? c.deployDelaySec / 60 : c.deployDelaySec}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, '')) || 1;
                set('deployDelaySec', unit === 'min' ? n * 60 : n);
              }}
            />
            <Segmented
              value={unit}
              onChange={(u) => {
                setUnit(u);
                if (u === 'min') set('deployDelaySec', Math.max(1, Math.round(c.deployDelaySec / 60)) * 60);
              }}
              options={[
                { value: 'sec', label: '초' },
                { value: 'min', label: '분' },
              ]}
            />
            <span className="text-sm text-muted">뒤 배포 (기다리는 중 또 푸시하면 다시 기다립니다)</span>
          </div>
        )}
        <Toggle checked={c.autostart} onChange={(v) => set('autostart', v)} label="서버 재부팅 시 자동 시작" />
      </Fold>

      <Fold icon={<GitBranch size={16} />} title="저장소" summary={`${repoShort} · ${c.branch}${c.rootDir ? ` · ${c.rootDir}` : ''}`}>
        <Field label="저장소 주소">
          <input className="input mono" value={c.repoUrl} onChange={(e) => set('repoUrl', e.target.value)} spellCheck={false} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="브랜치">
            <input className="input mono" value={c.branch} onChange={(e) => set('branch', e.target.value)} />
          </Field>
          <Field label="루트 폴더" hint="모노레포 하위 폴더">
            <input className="input mono" value={c.rootDir} onChange={(e) => set('rootDir', e.target.value)} placeholder="/" />
          </Field>
          <Field label="접근 방식">
            <select className="input" value={c.auth} onChange={(e) => set('auth', e.target.value as AppConfig['auth'])}>
              <option value="none">공개 저장소</option>
              <option value="token">GitHub 토큰</option>
              <option value="deploykey">배포 키 (SSH)</option>
            </select>
          </Field>
        </div>
        {c.auth === 'token' && (
          <Field label="이 앱 전용 GitHub 토큰" hint={secrets?.gitTokenSet ? '설정되어 있습니다. 새 값을 넣으면 바뀝니다 (비우고 저장하면 설정의 기본 토큰 사용).' : '비우면 설정 → GitHub · 알림의 기본 토큰을 씁니다.'}>
            <div className="flex gap-2">
              <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={secrets?.gitTokenSet ? '••••••••' : 'github_pat_...'} autoComplete="off" />
              <Button loading={busy === 'token'} onClick={() => run('token', () => api.put(`/api/apps/${app.slug}/secrets`, { gitToken: token }).then(() => (setToken(''), reloadSecrets())), '토큰을 저장했습니다')}>
                저장
              </Button>
            </div>
          </Field>
        )}
        {c.auth === 'deploykey' && (
          <Field label="배포 키 (공개키)" hint="GitHub 저장소 → Settings → Deploy keys 에 등록하세요 (쓰기 권한 불필요)">
            {deployKey ? <CopyField value={deployKey} /> : <div className="text-sm text-muted">저장하면 키가 만들어집니다</div>}
            {deployKey && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                icon={<KeyRound size={14} />}
                loading={busy === 'key'}
                onClick={async () => {
                  if (!(await confirm({ title: '배포 키 다시 만들기', body: '기존 키는 더 이상 쓸 수 없습니다. 새 공개키를 GitHub 에 다시 등록해야 합니다.', confirm: '다시 만들기', danger: true }))) return;
                  run('key', async () => setDeployKey((await api.post<{ publicKey: string }>(`/api/apps/${app.slug}/deploykey`)).publicKey), '새 키를 만들었습니다');
                }}
              >
                키 다시 만들기
              </Button>
            )}
          </Field>
        )}
      </Fold>

      <Fold icon={<Play size={16} />} title="빌드 · 실행" summary={`${c.runtime === 'node' ? 'Node.js' : 'Python'} ${c.runtimeVersion}${c.buildCmd ? ` · 빌드 ${c.buildCmd}` : ''}`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="런타임">
            <Segmented
              value={c.runtime}
              onChange={(v) => setC((x) => ({ ...x, runtime: v, runtimeVersion: v === 'node' ? '24' : 'system' }))}
              options={[
                { value: 'node', label: 'Node.js' },
                { value: 'python', label: 'Python 3' },
              ]}
            />
          </Field>
          <Field label="버전" hint={c.runtime === 'node' ? '예: 24, 22, 22.11.0 (없으면 자동 설치)' : 'system 또는 3.12 같은 버전 (uv 로 자동 설치)'}>
            <input className="input mono" value={c.runtimeVersion} onChange={(e) => set('runtimeVersion', e.target.value)} />
          </Field>
        </div>
        <Field label="설치 명령" hint="비우면 lockfile / requirements.txt 를 보고 자동으로 정합니다">
          <input className="input mono" value={c.installCmd} onChange={(e) => set('installCmd', e.target.value)} placeholder="(자동)" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="빌드 명령">
            <input className="input mono" value={c.buildCmd} onChange={(e) => set('buildCmd', e.target.value)} placeholder="없음" />
          </Field>
          <Field label="배포 직전 명령" hint="빌드 후, 재시작 직전에 실행 (마이그레이션 등)">
            <input className="input mono" value={c.releaseCmd} onChange={(e) => set('releaseCmd', e.target.value)} placeholder="없음" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle checked={c.installAlways} onChange={(v) => set('installAlways', v)} label="배포마다 의존성 설치" sub="끄면 의존성 파일이 바뀔 때만 설치 (빠름)" />
          <Toggle
            checked={c.allowInstallScripts}
            onChange={(v) => set('allowInstallScripts', v)}
            label="패키지 설치 스크립트 허용"
            sub="npm 11 / pnpm 10 은 기본으로 막습니다. sharp, bcrypt, prisma 같은 네이티브 모듈에 필요"
          />
          <Toggle checked={c.forceColor} onChange={(v) => set('forceColor', v)} label="로그 색상 출력 (FORCE_COLOR=1)" />
          <Toggle checked={c.writeDotenv} onChange={(v) => set('writeDotenv', v)} label="앱 폴더에 .env 파일도 쓰기" sub="dotenv 처럼 파일을 직접 읽는 앱용. 환경변수는 항상 주입됩니다" />
          <Toggle checked={c.runAsRoot} onChange={(v) => set('runAsRoot', v)} label="root 로 실행" sub="권장하지 않음. 기본은 앱 전용 계정 hr-ID" />
        </div>
        <Field label="죽으면 다시 켜기">
          <select className="input sm:w-72" value={c.restartPolicy} onChange={(e) => set('restartPolicy', e.target.value as AppConfig['restartPolicy'])}>
            <option value="on-failure">오류로 종료되면 다시 켜기 (권장)</option>
            <option value="always">항상 다시 켜기 (정상 종료여도)</option>
            <option value="no">다시 켜지 않기</option>
          </select>
        </Field>
      </Fold>

      <Fold
        icon={<Rocket size={16} />}
        title="배포 세부 동작"
        summary={`${modeText(c.deployMode, c.deployDelaySec)} · ${c.pollEnabled ? `${c.pollIntervalSec}초마다 새 커밋 확인` : '웹후크로만 감지'} · ${c.autoRollback ? '실패 시 되돌리기' : '되돌리기 꺼짐'}`}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle checked={c.pollEnabled} onChange={(v) => set('pollEnabled', v)} label="주기적으로 새 커밋 확인" sub="웹후크 없이도 동작합니다. 공개 주소가 없어도 됩니다" />
          {c.pollEnabled && (
            <Field label="확인 주기 (초)">
              <input className="input mono w-32" inputMode="numeric" value={c.pollIntervalSec} onChange={(e) => set('pollIntervalSec', Number(e.target.value.replace(/\D/g, '')) || 60)} />
            </Field>
          )}
          <Toggle checked={c.autoRollback} onChange={(v) => set('autoRollback', v)} label="실패하면 이전 버전으로 되돌리기" sub="새 버전이 시작에 실패하거나 상태 확인을 통과하지 못할 때" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="상태 확인 경로" hint="배포 후 이 경로가 200 을 돌려주는지 확인합니다. 비우면 5초간 살아 있는지만 봅니다">
            <input className="input mono" value={c.healthPath} onChange={(e) => set('healthPath', e.target.value)} placeholder="/health" />
          </Field>
          <Field label="상태 확인 제한 시간 (초)">
            <input className="input mono" inputMode="numeric" value={c.healthTimeoutSec} onChange={(e) => set('healthTimeoutSec', Number(e.target.value.replace(/\D/g, '')) || 30)} />
          </Field>
        </div>
        <Field label="감시 경로 (선택)" hint="이 경로가 바뀐 푸시만 배포합니다 (모노레포용). 한 줄에 하나, 예: apps/api/  ·  비우면 모든 변경">
          <textarea className="input mono min-h-[70px]" value={c.watchPaths.join('\n')} onChange={(e) => set('watchPaths', e.target.value.split('\n'))} placeholder="src/&#10;package.json" />
        </Field>
      </Fold>

      <Fold icon={<HardDrive size={16} />} title="서버에 남길 파일" summary={`${c.preservePaths.filter((x) => x.trim()).length}개 경로 · 배포해도 그대로 유지`}>
        <p className="text-sm text-muted">
          배포는 git pull 처럼 동작합니다. 저장소에 없는 파일(SQLite DB, 업로드 등)은 건드리지 않고, 아래 경로는 저장소에 같은 파일이 있어도 서버의 것을 유지합니다. 덮어쓰거나 지워질 파일은 배포 전에 자동으로 백업합니다.
        </p>
        <Field label="유지할 경로" hint="gitignore 형식. /data/ = 루트의 data 폴더, *.db = 모든 위치의 .db 파일">
          <textarea className="input mono min-h-[150px] text-[13px]" value={c.preservePaths.join('\n')} onChange={(e) => set('preservePaths', e.target.value.split('\n'))} spellCheck={false} />
        </Field>
        <Field label="서버에서 직접 고친 저장소 파일은">
          <select className="input sm:w-96" value={c.localChanges} onChange={(e) => set('localChanges', e.target.value as AppConfig['localChanges'])}>
            <option value="overwrite">저장소 버전으로 덮어쓰기 (원본은 백업)</option>
            <option value="keep">서버 수정본 유지 (저장소 변경 무시)</option>
          </select>
        </Field>
      </Fold>

      <Fold icon={<Gauge size={16} />} title="리소스 제한" summary={resourceSummary(c.resources)}>
        <p className="text-sm text-muted">이 앱만 따로 제한합니다. 저장하면 재시작 없이 바로 적용됩니다. 비우면 제한 없음.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="CPU (코어)" hint="0.5 = 코어 절반, 2 = 두 개">
            <input className="input mono" inputMode="decimal" value={c.resources.cpu ?? ''} onChange={(e) => set('resources', { ...c.resources, cpu: numOrNull(e.target.value) })} placeholder="제한 없음" />
          </Field>
          <Field label="메모리 (MB)" hint="넘으면 강제로 재시작됩니다">
            <input className="input mono" inputMode="numeric" value={c.resources.memoryMB ?? ''} onChange={(e) => set('resources', { ...c.resources, memoryMB: numOrNull(e.target.value.replace(/\D/g, '')) })} placeholder="제한 없음" />
          </Field>
          <Field label="스왑 (MB)" hint="0 = 스왑 사용 안 함">
            <input className="input mono" inputMode="numeric" value={c.resources.swapMB ?? ''} onChange={(e) => set('resources', { ...c.resources, swapMB: numOrNull(e.target.value.replace(/\D/g, '')) })} placeholder="제한 없음" />
          </Field>
          <Field label="최대 프로세스/스레드">
            <input className="input mono" inputMode="numeric" value={c.resources.tasks ?? ''} onChange={(e) => set('resources', { ...c.resources, tasks: numOrNull(e.target.value.replace(/\D/g, '')) })} placeholder="제한 없음" />
          </Field>
          <Field label="CPU 우선순위" hint="CPU 가 부족할 때 나눠 갖는 비율">
            <select className="input" value={c.resources.cpuWeight ?? ''} onChange={(e) => set('resources', { ...c.resources, cpuWeight: numOrNull(e.target.value) })}>
              <option value="">보통 (100)</option>
              <option value="25">낮음 (25)</option>
              <option value="50">조금 낮음 (50)</option>
              <option value="200">높음 (200)</option>
              <option value="500">매우 높음 (500)</option>
            </select>
          </Field>
        </div>
      </Fold>

      <Fold icon={<Bell size={16} />} title="디스코드 알림" summary={`${secrets?.discordWebhook ? '이 앱 전용 웹후크' : '설정의 기본 웹후크'} · ${notifyOn}개 항목`}>
        <Field label="이 앱 전용 웹후크" hint="비우면 설정의 기본 웹후크를 씁니다">
          <div className="flex gap-2">
            <input className="input mono" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
            <Button loading={busy === 'dc'} onClick={() => run('dc', () => api.put(`/api/apps/${app.slug}/secrets`, { discordWebhook: discord }).then(reloadSecrets), '저장했습니다')}>
              저장
            </Button>
            <Button variant="ghost" loading={busy === 'test'} onClick={() => run('test', () => api.post(`/api/apps/${app.slug}/test-notify`), '테스트 알림을 보냈습니다')}>
              테스트
            </Button>
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ['push', '새 푸시 감지'],
              ['pending', '승인 대기'],
              ['start', '배포 시작'],
              ['success', '배포 성공'],
              ['failure', '배포 실패 / 되돌림'],
              ['crash', '앱이 죽었을 때'],
            ] as const
          ).map(([k, label]) => (
            <Toggle key={k} checked={c.notify[k]} onChange={(v) => set('notify', { ...c.notify, [k]: v })} label={label} />
          ))}
        </div>
      </Fold>

      <Fold icon={<Webhook size={16} />} title="GitHub 웹후크" summary="선택 · 푸시를 몇 초 안에 바로 감지">
        <p className="text-sm text-muted">
          없어도 주기적 확인으로 배포됩니다. 더 빨리 감지하려면 GitHub 저장소 → Settings → Webhooks 에 아래 값을 넣으세요. 이 주소만 cloudflared 로 공개하면 됩니다 (서명으로 검증하므로 로그인 없이 받습니다).
        </p>
        <Field label="Payload URL">
          <CopyField value={hookUrl} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Content type">
            <CopyField value="application/json" />
          </Field>
          <Field label="Secret">
            <CopyField value={secrets?.webhookSecret ?? ''} secret />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'wh'}
            onClick={async () => {
              if (!(await confirm({ title: '웹후크 비밀값 다시 만들기', body: 'GitHub 에 등록한 Secret 도 바꿔야 합니다.', confirm: '다시 만들기' }))) return;
              run('wh', () => api.put(`/api/apps/${app.slug}/secrets`, { regenerateWebhook: true }).then(reloadSecrets), '새 비밀값을 만들었습니다');
            }}
          >
            비밀값 다시 만들기
          </Button>
          {!settings?.panel.baseUrl && <span className="text-xs text-muted">설정 → 패널 접속에 공개 주소를 넣으면 URL 이 그 주소로 표시됩니다</span>}
        </div>
      </Fold>

      <Fold
        icon={<Archive size={16} />}
        title="백업"
        summary={c.backup.enabled ? `예약 백업 ${c.backup.mode === 'daily' ? `매일 ${c.backup.time}` : `${c.backup.intervalHours}시간마다`} · ${c.backup.keep}개 보관` : '예약 백업 꺼짐 · 지금 백업 가능'}
      >
        <Toggle checked={c.backup.enabled} onChange={(v) => set('backup', { ...c.backup, enabled: v })} label="서버에 남길 파일을 주기적으로 백업" sub="SQLite 같은 파일 DB 를 쓰는 앱이라면 켜 두세요" />
        {c.backup.enabled && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="주기">
              <select className="input" value={c.backup.mode} onChange={(e) => set('backup', { ...c.backup, mode: e.target.value as 'daily' | 'interval' })}>
                <option value="daily">매일</option>
                <option value="interval">N시간마다</option>
              </select>
            </Field>
            {c.backup.mode === 'daily' ? (
              <Field label="시각">
                <input className="input mono" type="time" value={c.backup.time} onChange={(e) => set('backup', { ...c.backup, time: e.target.value })} />
              </Field>
            ) : (
              <Field label="간격 (시간)">
                <input className="input mono w-24" inputMode="numeric" value={c.backup.intervalHours} onChange={(e) => set('backup', { ...c.backup, intervalHours: Number(e.target.value.replace(/\D/g, '')) || 6 })} />
              </Field>
            )}
            <Field label="보관 개수">
              <input className="input mono w-24" inputMode="numeric" value={c.backup.keep} onChange={(e) => set('backup', { ...c.backup, keep: Number(e.target.value.replace(/\D/g, '')) || 7 })} />
            </Field>
          </div>
        )}
        <div className="border-t border-line pt-4">
          <AppBackups app={app} me={me} />
        </div>
      </Fold>

      <Fold icon={<Trash2 size={16} />} title="초기화 · 삭제" summary="클린 재배포, 앱 삭제" danger>
        <Danger app={app} me={me} />
      </Fold>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center p-4 lg:pl-60">
        <div className={`pointer-events-auto flex items-center gap-3 rounded-2xl border border-line-2 bg-surface-2/95 px-4 py-2.5 shadow-2xl backdrop-blur transition-all ${dirty ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0'}`}>
          <span className="text-sm text-fg-2">저장하지 않은 변경이 있습니다</span>
          <Button size="sm" variant="ghost" onClick={() => (setC(app.config), setName(app.name))}>
            되돌리기
          </Button>
          <Button size="sm" variant="primary" icon={<Save size={14} />} loading={saving} onClick={save}>
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}

function AppBackups({ app, me }: { app: AppDetailData; me: Me }) {
  const { data, reload } = useApi<Backup[]>(`/api/backups?kind=app&slug=${app.slug}`, { refreshOn: ['backups'] });
  const [job, setJob] = useState<number | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">"데이터 백업" 은 서버에 남길 파일과 환경변수만, "전체 폴더 백업" 은 node_modules 를 뺀 앱 폴더 전체를 저장합니다.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={<Upload size={14} />} loading={busy === 'data'} onClick={() => run('data', async () => setJob((await api.post<{ jobId: number }>('/api/backups', { kind: 'app', slug: app.slug })).jobId))}>
          데이터 백업
        </Button>
        <Button size="sm" icon={<Download size={14} />} loading={busy === 'full'} onClick={() => run('full', async () => setJob((await api.post<{ jobId: number }>('/api/backups', { kind: 'app', slug: app.slug, full: true })).jobId))}>
          전체 폴더 백업
        </Button>
      </div>
      <BackupList list={data ?? []} me={me} reload={reload} />
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reload} />
    </div>
  );
}

function Danger({ app, me }: { app: AppDetailData; me: Me }) {
  const [open, setOpen] = useState(false);
  const [backup, setBackup] = useState(true);
  const [dropDbs, setDropDbs] = useState<string[]>([]);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">클린 재배포</div>
          <p className="mt-0.5 max-w-xl text-sm text-muted">의존성을 처음부터 다시 설치하고(Python 은 가상환경도 새로 만듦) 배포합니다. 패키지가 꼬였을 때 쓰세요.</p>
        </div>
        <Button
          icon={<RotateCcw size={15} />}
          loading={busy === 'clean'}
          onClick={async () => {
            if (!(await confirm({ title: '클린 재배포', body: '의존성을 새로 설치하고 현재 브랜치의 최신 커밋으로 배포합니다.', confirm: '재배포' }))) return;
            run('clean', async () => {
              const r = await api.post<{ id: number }>(`/api/apps/${app.slug}/deploy`, { clean: true });
              navigate(`/apps/${app.slug}?tab=deploys&deploy=${r.id}`);
            });
          }}
        >
          클린 재배포
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <div>
          <div className="font-medium text-bad">앱 삭제</div>
          <p className="mt-0.5 max-w-xl text-sm text-muted">프로세스를 멈추고 코드, 환경변수, 배포 기록, 서비스, 전용 계정을 모두 지웁니다. 지우기 전에 최종 백업을 남길 수 있습니다.</p>
        </div>
        <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setOpen(true)}>
          앱 삭제
        </Button>
      </div>
      <DangerDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${app.name} 삭제`}
        target={app.slug}
        needTotp={me.totpEnabled}
        items={[
          <>
            앱 폴더 <code className="text-xs">{app.dir}</code> (코드, 로컬 DB 파일, 업로드 등)
          </>,
          `환경변수 ${app.envCount}개, 배포 기록, 배포 키`,
          `systemd 서비스 hrone-app-${app.slug} 와 계정 hr-${app.slug}`,
          ...(dropDbs.length ? [`연결된 DB: ${dropDbs.join(', ')} (데이터 포함)`] : []),
        ]}
        options={
          <>
            <Toggle checked={backup} onChange={setBackup} label="삭제 전 최종 백업 만들기 (권장)" sub="앱 폴더 전체 + 환경변수를 서버 → 백업에 남깁니다" />
            {app.links.map((l) => (
              <Toggle
                key={l.slug}
                checked={dropDbs.includes(l.slug)}
                onChange={(v) => setDropDbs(v ? [...dropDbs, l.slug] : dropDbs.filter((x) => x !== l.slug))}
                label={`연결된 DB "${l.name}" 도 삭제`}
                sub="다른 앱도 쓰고 있다면 끄세요"
              />
            ))}
          </>
        }
        onConfirm={async (auth) => {
          const r = await api.post<{ backupFile: string | null }>(`/api/apps/${app.slug}/terminate`, { ...auth, backup, databases: dropDbs });
          toast.ok(`삭제했습니다${r.backupFile ? ' (최종 백업은 서버 → 백업에 있습니다)' : ''}`);
          navigate('/apps');
        }}
      />
    </div>
  );
}
