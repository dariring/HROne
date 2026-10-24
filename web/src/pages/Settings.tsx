import QRCode from 'qrcode';
import { Bell, GitBranch, KeyRound, Monitor, Save, Shield, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ReauthDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { Badge, Button, Card, CopyField, Field, IconButton, Modal, Notice, PageHeader, Segmented, Tabs, Toggle, toast, useAction } from '../components/ui';
import { api, errorText } from '../lib/api';
import { ago } from '../lib/format';
import { setQuery, useLocation, useTitle } from '../lib/router';
import { useApi } from '../lib/store';
import { AuditPanel } from './Audit';

interface SettingsData {
  panel: { port: number; access: 'private' | 'all' | 'custom'; allowedCidrs: string[]; baseUrl: string };
  defaults: { pollIntervalSec: number; notify: Record<string, boolean> };
  alerts: { enabled: boolean; diskPercent: number; memPercent: number };
  githubTokenSet: boolean;
  discordWebhook: string;
  discordSet: boolean;
}

function Section({ icon, title, children, actions }: { icon: ReactNode; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="text-accent-2">{icon}</span>
          {title}
        </span>
      }
      actions={actions}
    >
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

type SettingsTab = 'account' | 'connect' | 'access' | 'audit';

export function Settings({ me }: { me: Me }) {
  useTitle('설정');
  const { query } = useLocation();
  const tab = (query.get('tab') as SettingsTab) || 'account';
  const { data, reload } = useApi<SettingsData>('/api/settings');
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="설정" />
      <Tabs
        value={tab}
        onChange={(t) => setQuery('tab', t === 'account' ? null : t)}
        tabs={[
          { value: 'account', label: '내 계정' },
          { value: 'connect', label: 'GitHub · 알림' },
          { value: 'access', label: '패널 접속' },
          { value: 'audit', label: '활동 기록' },
        ]}
      />
      {tab === 'account' && (
        <div className="space-y-5">
          <Account me={me} />
          <UsersCard me={me} />
        </div>
      )}
      {tab === 'connect' && data && (
        <div className="space-y-5">
          <GitHub s={data} reload={reload} />
          <Notifications s={data} reload={reload} />
        </div>
      )}
      {tab === 'access' && data && <PanelAccess s={data} reload={reload} />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  );
}

function PanelAccess({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [p, setP] = useState(s.panel);
  const [cidrs, setCidrs] = useState(s.panel.allowedCidrs.join('\n'));
  useEffect(() => {
    setP(s.panel);
    setCidrs(s.panel.allowedCidrs.join('\n'));
  }, [s]);
  const { busy, run } = useAction();
  return (
    <Section icon={<Shield size={16} />} title="패널 접속">
      <Field label="접속 허용" hint="GitHub 웹후크 주소(/api/hooks/...)는 이 제한과 상관없이 서명으로만 확인합니다">
        <Segmented
          value={p.access}
          onChange={(v) => setP({ ...p, access: v })}
          options={[
            { value: 'private', label: 'Tailscale · 사설망만' },
            { value: 'custom', label: '지정한 IP 만' },
            { value: 'all', label: '모든 IP' },
          ]}
        />
      </Field>
      {p.access === 'private' && (
        <div className="text-sm text-muted">허용: 127.0.0.1, Tailscale (100.64.0.0/10, fd7a::/48), 10/8, 172.16/12, 192.168/16. cloudflared 를 거쳐 들어온 외부 요청은 실제 IP 로 판단해서 막습니다.</div>
      )}
      {p.access === 'all' && <Notice tone="red">공인 IP 에서도 로그인 화면이 열립니다. OTP 를 꼭 켜고, 가능하면 Cloudflare Access 등으로 한 겹 더 막으세요.</Notice>}
      {p.access === 'custom' && (
        <Field label="허용할 IP / CIDR (한 줄에 하나)" hint="127.0.0.1 은 항상 허용됩니다">
          <textarea className="input mono min-h-[90px]" value={cidrs} onChange={(e) => setCidrs(e.target.value)} placeholder={'100.64.0.0/10\n203.0.113.7'} />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="패널 포트" hint="바꾸면 패널이 재시작됩니다">
          <input className="input mono" inputMode="numeric" value={p.port} onChange={(e) => setP({ ...p, port: Number(e.target.value.replace(/\D/g, '')) || 7700 })} />
        </Field>
        <Field label="패널 공개 주소 (선택)" hint="디스코드 알림 링크와 웹후크 URL 에 쓰입니다. 예: http://100.x.y.z:7700">
          <input className="input" value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} placeholder={location.origin} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button
          variant="primary"
          icon={<Save size={15} />}
          loading={busy === 's'}
          onClick={() =>
            run('s', async () => {
              const r = await api.put<{ restartNeeded: boolean }>('/api/settings', { panel: { ...p, allowedCidrs: cidrs.split('\n').map((x) => x.trim()).filter(Boolean) } });
              if (r.restartNeeded) {
                await api.post('/api/system/restart-panel');
                toast.info(`포트를 바꿔 패널을 재시작합니다. 새 주소: ${location.protocol}//${location.hostname}:${p.port}`);
                setTimeout(() => (location.href = `${location.protocol}//${location.hostname}:${p.port}${location.pathname}`), 3500);
              } else toast.ok('저장했습니다');
              reload();
            })
          }
        >
          저장
        </Button>
      </div>
    </Section>
  );
}

function GitHub({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [token, setToken] = useState('');
  const { busy, run } = useAction();
  return (
    <Section icon={<GitBranch size={16} />} title="GitHub" actions={s.githubTokenSet ? <Badge tone="green">토큰 설정됨</Badge> : <Badge>토큰 없음</Badge>}>
      <p className="text-sm text-muted">
        비공개 저장소를 받거나 앱 추가 화면에서 내 저장소 목록을 보려면 토큰을 넣으세요. Fine-grained token 이라면 Repository access 에서 저장소를 고르고 Contents: Read-only, Metadata: Read-only 면 충분합니다.
      </p>
      <div className="flex gap-2">
        <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.githubTokenSet ? '새 토큰으로 바꾸기' : 'github_pat_... 또는 ghp_...'} autoComplete="off" />
        <Button
          variant="primary"
          disabled={!token}
          loading={busy === 's'}
          onClick={() =>
            run('s', async () => {
              await api.put('/api/settings', { githubToken: token });
              const r = await api.get<{ repos: unknown[] }>('/api/github/repos').catch((e) => {
                throw new Error(`저장했지만 확인에 실패했습니다: ${errorText(e)}`);
              });
              toast.ok(`저장했습니다 · 저장소 ${r.repos.length}개 보임`);
              setToken('');
              reload();
            })
          }
        >
          저장
        </Button>
        {s.githubTokenSet && (
          <Button variant="ghost" loading={busy === 'd'} onClick={() => run('d', () => api.put('/api/settings', { githubToken: '' }).then(reload), '토큰을 지웠습니다')}>
            지우기
          </Button>
        )}
      </div>
    </Section>
  );
}

function Notifications({ s, reload }: { s: SettingsData; reload: () => void }) {
  const [url, setUrl] = useState('');
  const [d, setD] = useState(s.defaults);
  const [a, setA] = useState(s.alerts);
  useEffect(() => {
    setD(s.defaults);
    setA(s.alerts);
  }, [s]);
  const { busy, run } = useAction();
  return (
    <Section icon={<Bell size={16} />} title="알림 (디스코드)">
      <Field label="전역 웹후크" hint={s.discordSet ? `현재: ${s.discordWebhook}` : '디스코드 채널 → 설정 → 연동 → 웹후크 → URL 복사'}>
        <div className="flex gap-2">
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." />
          <Button variant="primary" disabled={!url} loading={busy === 'u'} onClick={() => run('u', () => api.put('/api/settings', { discordWebhook: url }).then(() => (setUrl(''), reload())), '저장했습니다')}>
            저장
          </Button>
          {s.discordSet && (
            <>
              <Button variant="ghost" loading={busy === 't'} onClick={() => run('t', () => api.post('/api/settings/test-discord'), '테스트 알림을 보냈습니다')}>
                테스트
              </Button>
              <Button variant="ghost" loading={busy === 'x'} onClick={() => run('x', () => api.put('/api/settings', { discordWebhook: '' }).then(reload), '지웠습니다')}>
                지우기
              </Button>
            </>
          )}
        </div>
      </Field>
      <div>
        <div className="label">새 앱의 기본 알림 항목</div>
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ['push', '새 푸시 감지'],
              ['pending', '승인 대기'],
              ['start', '배포 시작'],
              ['success', '배포 성공'],
              ['failure', '배포 실패'],
              ['crash', '크래시'],
            ] as const
          ).map(([k, label]) => (
            <Toggle key={k} checked={!!d.notify[k]} onChange={(v) => setD({ ...d, notify: { ...d.notify, [k]: v } })} label={label} />
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="새 앱 기본 폴링 주기 (초)">
          <input className="input mono" inputMode="numeric" value={d.pollIntervalSec} onChange={(e) => setD({ ...d, pollIntervalSec: Number(e.target.value.replace(/\D/g, '')) || 60 })} />
        </Field>
        <Field label="디스크 경고 (%)">
          <input className="input mono" inputMode="numeric" value={a.diskPercent} onChange={(e) => setA({ ...a, diskPercent: Number(e.target.value.replace(/\D/g, '')) || 90 })} />
        </Field>
        <Field label="메모리 경고 (%, 3분 지속)">
          <input className="input mono" inputMode="numeric" value={a.memPercent} onChange={(e) => setA({ ...a, memPercent: Number(e.target.value.replace(/\D/g, '')) || 95 })} />
        </Field>
      </div>
      <Toggle checked={a.enabled} onChange={(v) => setA({ ...a, enabled: v })} label="서버 경고 알림 (디스크/메모리/DB 다운)" />
      <div className="flex justify-end">
        <Button variant="primary" icon={<Save size={15} />} loading={busy === 's'} onClick={() => run('s', () => api.put('/api/settings', { defaults: d, alerts: a }).then(reload), '저장했습니다')}>
          저장
        </Button>
      </div>
    </Section>
  );
}

function Account({ me }: { me: Me }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [totpOtp, setTotpOtp] = useState('');
  const { busy, run } = useAction();
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const { data: sessions, reload } = useApi<{ id: string; created_at: number; last_seen_at: number; ip: string; user_agent: string; current: boolean }[]>('/api/auth/sessions');
  return (
    <>
      <Section icon={<KeyRound size={16} />} title={`내 계정 (${me.username})`}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="현재 비밀번호">
            <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="새 비밀번호" hint="8자 이상">
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="새 비밀번호 확인">
            <input className="input" type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        {me.totpEnabled && (
          <Field label="OTP 코드">
            <input className="input mono w-40" inputMode="numeric" maxLength={6} value={totpOtp} onChange={(e) => setTotpOtp(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!cur || next.length < 8 || next !== next2}
            loading={busy === 'pw'}
            onClick={() => run('pw', () => api.post('/api/auth/password', { current: cur, next, totp: totpOtp }).then(() => (setCur(''), setNext(''), setNext2(''))), '비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊겼습니다.')}
          >
            비밀번호 변경
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div>
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck size={16} className={me.totpEnabled ? 'text-ok' : 'text-muted'} />
              2단계 인증 (OTP)
              {me.totpEnabled ? <Badge tone="green">켜짐</Badge> : <Badge>꺼짐</Badge>}
            </div>
            <div className="mt-1 text-sm text-muted">로그인과 삭제·복원 같은 위험한 작업에 인증 앱 코드를 요구합니다.</div>
          </div>
          {me.totpEnabled ? (
            <Button variant="ghost" onClick={() => setDisableOpen(true)}>
              끄기
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy === 'otp'}
              onClick={() =>
                run('otp', async () => {
                  const r = await api.post<{ secret: string; uri: string }>('/api/auth/totp/begin');
                  const qr = await QRCode.toDataURL(r.uri, { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } });
                  setSetup({ ...r, qr });
                  setCode('');
                })
              }
            >
              OTP 켜기
            </Button>
          )}
        </div>
      </Section>

      <Section icon={<Monitor size={16} />} title="로그인된 기기">
        <div className="divide-y divide-line">
          {(sessions ?? []).map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{s.user_agent.replace(/\(.*?\)/g, '').slice(0, 80) || '알 수 없는 브라우저'}</div>
                <div className="text-xs text-muted">
                  {s.ip} · 마지막 {ago(s.last_seen_at)}
                </div>
              </div>
              {s.current ? (
                <Badge tone="green">지금 이 기기</Badge>
              ) : (
                <IconButton title="로그아웃시키기" onClick={() => run(`s${s.id}`, () => api.del(`/api/auth/sessions/${s.id}`).then(reload), '로그아웃시켰습니다')}>
                  <Trash2 size={15} />
                </IconButton>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Modal
        open={!!setup}
        onClose={() => setSetup(null)}
        title="OTP 설정"
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              취소
            </Button>
            <Button
              variant="primary"
              disabled={code.length !== 6}
              loading={busy === 'en'}
              onClick={() =>
                run('en', async () => {
                  await api.post('/api/auth/totp/enable', { secret: setup!.secret, code });
                  setSetup(null);
                  location.reload();
                }, 'OTP 를 켰습니다')
              }
            >
              확인하고 켜기
            </Button>
          </>
        }
      >
        {setup && (
          <div className="space-y-4 text-sm">
            <p className="text-fg-2">Google Authenticator, 1Password, Authy 등으로 QR 을 찍은 뒤 나오는 6자리 코드를 입력하세요.</p>
            <img src={setup.qr} alt="OTP QR" className="mx-auto rounded-xl" width={220} height={220} />
            <Field label="직접 입력용 키">
              <CopyField value={setup.secret} />
            </Field>
            <Field label="6자리 코드">
              <input className="input mono text-center text-lg tracking-[0.4em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            </Field>
            <p className="text-xs text-muted">휴대폰을 잃어버리면 서버에서 sudo hrone disable-2fa {me.username} 로 끌 수 있습니다.</p>
          </div>
        )}
      </Modal>
      <ReauthDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="OTP 끄기"
        needTotp
        danger
        confirmLabel="끄기"
        onConfirm={async (auth) => {
          await api.post('/api/auth/totp/disable', auth);
          location.reload();
        }}
      />
    </>
  );
}

function UsersCard({ me }: { me: Me }) {
  const { data, reload } = useApi<{ id: number; username: string; totpEnabled: boolean; lastLoginAt: number | null }[]>('/api/users');
  const [open, setOpen] = useState(false);
  const [u, setU] = useState('');
  const [pw, setPw] = useState('');
  const [del, setDel] = useState<{ id: number; username: string } | null>(null);
  const { busy, run } = useAction();
  return (
    <Section icon={<Users size={16} />} title="관리자 계정" actions={<Button size="sm" icon={<UserPlus size={14} />} onClick={() => setOpen(true)}>추가</Button>}>
      <div className="divide-y divide-line">
        {(data ?? []).map((x) => (
          <div key={x.id} className="flex items-center gap-3 py-2.5 text-sm">
            <span className="flex-1 font-medium">{x.username}</span>
            {x.totpEnabled && <Badge tone="green">OTP</Badge>}
            <span className="text-xs text-muted">{x.lastLoginAt ? `${ago(x.lastLoginAt)} 로그인` : '로그인 기록 없음'}</span>
            {x.username !== me.username && (
              <IconButton title="삭제" onClick={() => setDel(x)}>
                <Trash2 size={15} />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      <div className="text-xs text-muted">모든 계정은 같은 전체 권한을 가집니다. 변경 내용은 활동 기록에 계정별로 남습니다.</div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="관리자 추가"
        width={420}
        footer={
          <Button
            variant="primary"
            disabled={!u || pw.length < 8}
            loading={busy === 'add'}
            onClick={() => run('add', () => api.post('/api/users', { username: u, password: pw }).then(() => (setOpen(false), setU(''), setPw(''), reload())), '추가했습니다')}
          >
            추가
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label="아이디">
            <input className="input" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
          </Field>
          <Field label="비밀번호" hint="8자 이상. 로그인 후 본인이 바꾸게 하세요">
            <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
      </Modal>
      <ReauthDialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`${del?.username} 삭제`}
        danger
        confirmLabel="삭제"
        needTotp={me.totpEnabled}
        onConfirm={async (auth) => {
          await api.post(`/api/users/${del!.id}/delete`, auth);
          toast.ok('삭제했습니다');
          reload();
        }}
      />
    </Section>
  );
}
