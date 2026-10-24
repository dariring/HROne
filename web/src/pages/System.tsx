import { Cloud, Cpu, Download, Globe, HardDrive, Layers, Network, Package, RefreshCw, Save, Server, SlidersHorizontal, Trash2, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AreaChart } from '../components/Charts';
import { JobDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { Badge, Button, Card, CopyField, KV, Loading, Meter, Notice, PageHeader, Segmented, Tabs, cx, toast, useAction, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { bytes, duration, pct, rate } from '../lib/format';
import { setQuery, useLocation, useTitle } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import { BackupsPanel } from './Backups';

interface Info {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memTotal: number;
  virtualization: string;
  container: boolean;
  timezone: string;
  networks: { name: string; address: string }[];
  panelNode: string;
  panelVersion: string;
  tailscale: { installed: false } | { installed: true; ip: string | null; dnsName: string | null; state: string | null; service: string };
  cloudflared: { installed: false } | { installed: true; version: string; service: string; ingress: { hostname: string; service: string }[] };
  cgroupControllers: string[];
}

interface Res {
  cpu: number | null;
  memoryMB: number | null;
  swapMB: number | null;
  tasks: number | null;
  cpuWeight: number | null;
}

type SysTab = 'status' | 'backups' | 'advanced';

export function System({ me }: { me: Me }) {
  useTitle('서버');
  const { query } = useLocation();
  const tab = (query.get('tab') as SysTab) || 'status';
  const { data: info } = useApi<Info>('/api/system/info');

  return (
    <div>
      <PageHeader title="서버" sub={info ? `${info.hostname} · ${info.os} · ${info.arch} · ${info.virtualization === 'none' ? '물리/베어메탈' : info.virtualization.toUpperCase()}` : ''} icon={<Server size={20} />} />
      <Tabs
        value={tab}
        onChange={(t) => setQuery('tab', t === 'status' ? null : t)}
        tabs={[
          { value: 'status', label: '상태' },
          { value: 'backups', label: '백업' },
          { value: 'advanced', label: '고급' },
        ]}
      />
      {tab === 'status' && <StatusTab info={info ?? undefined} />}
      {tab === 'backups' && <BackupsPanel me={me} />}
      {tab === 'advanced' && (
        <div className="space-y-6">
          <p className="text-sm text-muted">처음에는 건드리지 않아도 됩니다. 서버를 직접 조정하고 싶을 때만 쓰세요.</p>
          <SliceLimits info={info ?? undefined} />
          <div className="grid gap-5 xl:grid-cols-2">
            <Components />
            <div className="space-y-5">
              <Tuning container={!!info?.container} />
              <Swap />
              <Timezone current={info?.timezone} />
              <JournalCard />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusTab({ info }: { info: Info | undefined }) {
  const live = useLive();
  const sys = live.system;
  const [range, setRange] = useState<'1h' | '24h'>('1h');
  const { data: metrics } = useApi<{ history: { t: number; cpu: number; mem: number; rx: number; tx: number; load: number }[] }>(`/api/system/metrics?range=${range}`, { interval: range === '1h' ? 10_000 : 60_000 });
  const h = metrics?.history ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={<span className="flex items-center gap-2"><Cpu size={16} /> CPU</span>}>
          {sys ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold">{pct(sys.cpu)}</span>
                <span className="text-xs text-muted">부하 {sys.load.toFixed(2)} · {sys.cores.length}코어</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
                {sys.cores.map((c, i) => (
                  <div key={i} title={`코어 ${i}: ${c}%`} className="h-10 overflow-hidden rounded bg-surface-3">
                    <div className="h-full w-full origin-bottom bg-accent/70 transition-transform duration-500" style={{ transform: `scaleY(${c / 100})` }} />
                  </div>
                ))}
              </div>
              <div className="truncate text-xs text-muted">{info?.cpuModel}</div>
            </div>
          ) : (
            <Loading />
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><Layers size={16} /> 메모리</span>}>
          {sys && (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold">{pct(sys.mem)}</span>
                <span className="text-xs text-muted">
                  {bytes(sys.memUsed)} / {bytes(sys.memTotal)}
                </span>
              </div>
              <Meter value={sys.mem} />
              <div className="flex justify-between text-xs text-muted">
                <span>스왑</span>
                <span>{sys.swapTotal ? `${bytes(sys.swapUsed)} / ${bytes(sys.swapTotal)}` : '없음'}</span>
              </div>
              {sys.swapTotal > 0 && <Meter value={(sys.swapUsed / sys.swapTotal) * 100} tone="blue" />}
            </div>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><HardDrive size={16} /> 디스크 · 네트워크</span>}>
          {sys && (
            <div className="space-y-3">
              {sys.disk.map((d) => (
                <div key={d.mount}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="mono text-muted">{d.mount}</span>
                    <span>
                      {bytes(d.used)} / {bytes(d.total)}
                    </span>
                  </div>
                  <Meter value={(d.used / d.total) * 100} />
                </div>
              ))}
              <div className="flex justify-between border-t border-line pt-3 text-xs">
                <span className="text-muted">수신 / 송신</span>
                <span>
                  ↓ {rate(sys.rx)} · ↑ {rate(sys.tx)}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">가동 시간</span>
                <span>{duration(sys.uptime)}</span>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="사용량 기록"
        actions={
          <Segmented
            value={range}
            onChange={setRange}
            options={[
              { value: '1h', label: '1시간' },
              { value: '24h', label: '24시간' },
            ]}
          />
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <AreaChart
            times={h.map((x) => x.t)}
            max={100}
            format={(v) => `${v.toFixed(0)}%`}
            series={[
              { label: 'CPU', color: 'var(--color-accent)', values: h.map((x) => x.cpu) },
              { label: '메모리', color: 'var(--color-info)', values: h.map((x) => x.mem) },
            ]}
          />
          <AreaChart
            times={h.map((x) => x.t)}
            format={(v) => rate(v)}
            series={[
              { label: '수신', color: 'var(--color-ok)', values: h.map((x) => x.rx) },
              { label: '송신', color: 'var(--color-warn)', values: h.map((x) => x.tx) },
            ]}
          />
        </div>
        {range === '24h' && <div className="hint">24시간 기록은 패널이 켜진 뒤부터 1분 단위로 모읍니다 (패널 재시작 시 초기화).</div>}
      </Card>

      <NetworkServices info={info} />
      <PanelUpdate version={info?.panelVersion} node={info?.panelNode} />
    </div>
  );
}

function SliceLimits({ info }: { info: Info | undefined }) {
  const { data, reload } = useApi<{ total: Res; apps: Res; dbs: Res }>('/api/system/limits');
  const live = useLive();
  const [v, setV] = useState<{ total: Res; apps: Res; dbs: Res } | null>(null);
  useEffect(() => setV(data), [data]);
  const { busy, run } = useAction();
  if (!v) return null;
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const rows: [keyof typeof v, string, string, string][] = [
    ['total', '전체 (앱 + DB)', 'hrone.slice', 'HROne 이 돌리는 모든 것의 합계 상한'],
    ['apps', '앱 전체', 'hrone-apps.slice', '모든 앱 합계'],
    ['dbs', 'DB 전체', 'hrone-dbs.slice', '모든 MariaDB/Redis 합계'],
  ];
  const noCpu = info && !info.cgroupControllers.includes('cpu');
  return (
    <Card title={<span className="flex items-center gap-2"><SlidersHorizontal size={16} /> 전체 사용량 상한</span>}>
      <p className="-mt-1 mb-4 text-sm text-muted">
        앱별 제한은 각 앱 설정에서, 여기서는 묶음 전체의 상한을 정합니다 (systemd slice). 패널 자신과 시스템 서비스(SSH, Tailscale, cloudflared)는 제외되므로 앱이 폭주해도 서버에 접속할 수 있습니다.
      </p>
      {noCpu && <Notice tone="yellow">이 환경은 cgroup cpu 컨트롤러가 없어 CPU 제한이 동작하지 않을 수 있습니다.</Notice>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2 font-medium">범위</th>
              <th className="py-2 font-medium">현재</th>
              <th className="py-2 font-medium">CPU 상한 (코어)</th>
              <th className="py-2 font-medium">메모리 상한 (MB)</th>
              <th className="py-2 font-medium">스왑 (MB)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(([k, label, unit, hint]) => {
              const st = live.units[unit];
              return (
                <tr key={k}>
                  <td className="py-2.5 pr-3">
                    <div className="font-medium">{label}</div>
                    <div className="text-xs text-muted">{hint}</div>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-fg-2">{st ? `CPU ${pct(st.cpu, 1)} · ${bytes(st.memory)}` : '-'}</td>
                  {(['cpu', 'memoryMB', 'swapMB'] as const).map((f) => (
                    <td key={f} className="py-2.5 pr-3">
                      <input className="input mono w-32" inputMode="decimal" value={v[k][f] ?? ''} placeholder="없음" onChange={(e) => setV({ ...v, [k]: { ...v[k], [f]: num(e.target.value) } })} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" icon={<Save size={15} />} disabled={JSON.stringify(v) === JSON.stringify(data)} loading={busy === 's'} onClick={() => run('s', () => api.put('/api/system/limits', v).then(reload), '바로 적용했습니다')}>
          저장 + 적용
        </Button>
      </div>
    </Card>
  );
}

function NetworkServices({ info }: { info: Info | undefined }) {
  if (!info) return null;
  const ts = info.tailscale;
  const cf = info.cloudflared;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title={<span className="flex items-center gap-2"><Network size={16} /> Tailscale</span>} actions={ts.installed ? <Badge tone={ts.state === 'Running' ? 'green' : 'yellow'}>{ts.state ?? ts.service}</Badge> : <Badge>미설치</Badge>}>
        {ts.installed ? (
          <KV
            items={[
              ['IP', ts.ip ? <span className="mono">{ts.ip}</span> : '-'],
              ['이름', ts.dnsName ?? '-'],
              ['패널 주소', ts.ip ? <span className="mono">http://{ts.ip}:{location.port || 80}</span> : '-'],
            ]}
          />
        ) : (
          <div className="space-y-2 text-sm text-muted">
            <p>설치하면 Tailscale 네트워크에서 이 패널과 DB 에 안전하게 접속할 수 있습니다.</p>
            <CopyField value="curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up" />
            {info.container && <p className="text-xs">LXC 라면 호스트에서 /dev/net/tun 을 컨테이너에 넘겨 줘야 합니다 (Proxmox: 컨테이너 설정에 lxc.cgroup2.devices.allow / mount entry 추가).</p>}
          </div>
        )}
      </Card>
      <Card title={<span className="flex items-center gap-2"><Cloud size={16} /> cloudflared</span>} actions={cf.installed ? <Badge tone={cf.service === 'active' ? 'green' : 'yellow'}>{cf.service === 'active' ? '실행 중' : cf.service}</Badge> : <Badge>미설치</Badge>}>
        {cf.installed ? (
          <div className="space-y-3 text-sm">
            <div className="text-xs text-muted">{cf.version}</div>
            {cf.ingress.length ? (
              <div className="space-y-1">
                {cf.ingress.map((r) => (
                  <div key={r.hostname} className="mono flex justify-between gap-3 text-[12.5px]">
                    <span>{r.hostname}</span>
                    <span className="text-muted">{r.service}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted">토큰 방식(대시보드 관리) 터널입니다. Cloudflare Zero Trust → Tunnels → Public Hostname 에서 서비스를 http://127.0.0.1:앱포트 로 지정하세요.</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">앱을 도메인으로 공개하려면 cloudflared 를 설치하고, 터널 Public Hostname 의 서비스를 http://127.0.0.1:앱포트 로 지정하세요. Nginx 는 필요 없습니다.</p>
        )}
      </Card>
    </div>
  );
}

function Components() {
  const { data, reload } = useApi<{ node: string[]; python: { version: string; path: string; managed: boolean }[]; uv: string | null; mariadb: string | null; redis: string | null; git: string | null; buildEssential: boolean }>('/api/system/components');
  const { data: nodeVersions } = useApi<{ version: string; lts: string | false }[]>('/api/system/node-versions');
  const [job, setJob] = useState<number | null>(null);
  const [py, setPy] = useState('3.12');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const install = (component: string, version?: string) => run(`i${component}${version ?? ''}`, async () => setJob((await api.post<{ jobId: number }>('/api/system/components/install', { component, version })).jobId));
  if (!data) return <Card title="구성 요소"><Loading /></Card>;
  return (
    <Card title={<span className="flex items-center gap-2"><Package size={16} /> 구성 요소 · 런타임</span>}>
      <div className="space-y-5 text-sm">
        <div>
          <div className="mb-2 font-medium">Node.js</div>
          <div className="flex flex-wrap gap-2">
            {data.node.map((v) => (
              <span key={v} className="inline-flex items-center gap-1 rounded-lg border border-line-2 bg-surface-2 py-1 pl-2.5 pr-1 text-[13px]">
                <span className="mono">{v}</span>
                <button
                  type="button"
                  className="rounded p-1 text-muted hover:text-bad cursor-pointer"
                  title="삭제"
                  onClick={async () => {
                    if (!(await confirm({ title: `Node ${v} 삭제`, confirm: '삭제', danger: true }))) return;
                    run(`rm${v}`, () => api.post('/api/system/components/remove', { component: 'node', version: v }).then(reload), '삭제했습니다');
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(nodeVersions ?? [])
              .filter((n) => !data.node.includes(n.version))
              .map((n) => (
                <Button key={n.version} size="sm" variant="ghost" icon={<Download size={13} />} loading={busy === `inode${n.version}`} onClick={() => install('node', n.version)}>
                  {n.version}
                  {n.lts ? ` LTS` : ''}
                </Button>
              ))}
          </div>
          <div className="hint">앱이 요구하는 버전은 배포할 때 자동으로 설치됩니다.</div>
        </div>
        <div className="border-t border-line pt-4">
          <div className="mb-2 font-medium">Python</div>
          <div className="space-y-1">
            {data.python.map((p) => (
              <div key={p.path} className="flex items-center gap-2 text-[13px]">
                <span className="mono">{p.version}</span>
                <Badge>{p.managed ? 'uv' : '시스템'}</Badge>
                <span className="mono truncate text-xs text-muted">{p.path}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select className="input h-8 w-28 py-0 text-[13px]" value={py} onChange={(e) => setPy(e.target.value)}>
              {['3.14', '3.13', '3.12', '3.11', '3.10', '3.9'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <Button size="sm" variant="ghost" icon={<Download size={13} />} loading={busy === `ipython${py}`} onClick={() => install('python', py)}>
              설치
            </Button>
            <span className="text-xs text-muted">uv {data.uv ? data.uv.replace(/^uv /, '') : '미설치'}</span>
          </div>
        </div>
        <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
          {(
            [
              ['MariaDB', data.mariadb, 'mariadb'],
              ['Redis', data.redis, 'redis'],
            ] as const
          ).map(([label, v, c]) => (
            <div key={c} className="flex items-center justify-between gap-2">
              <span>{label}</span>
              {v ? (
                <span className="mono text-xs text-muted">{v}</span>
              ) : (
                <Button size="sm" variant="ghost" icon={<Download size={13} />} loading={busy === `i${c}`} onClick={() => install(c)}>
                  설치
                </Button>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <span>git</span>
            <span className="mono text-xs text-muted">{data.git ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>빌드 도구 (gcc)</span>
            <span className="text-xs text-muted">{data.buildEssential ? '있음' : '없음'}</span>
          </div>
        </div>
      </div>
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reload} />
    </Card>
  );
}

function Tuning({ container }: { container: boolean }) {
  const { data, reload } = useApi<{ key: string; value: string; why: string; current: string | null }[]>('/api/system/tuning');
  const { busy, run } = useAction();
  if (!data) return null;
  const ok = (t: { key: string; value: string; current: string | null }) => t.current === t.value || (t.key.endsWith('somaxconn') && Number(t.current) >= Number(t.value)) || (t.key === 'fs.file-max' && Number(t.current) >= Number(t.value));
  return (
    <Card
      title={<span className="flex items-center gap-2"><Wrench size={16} /> 커널 튜닝 (동시 접속 / Redis)</span>}
      actions={
        <Button
          size="sm"
          variant="primary"
          loading={busy === 't'}
          onClick={() =>
            run('t', async () => {
              const r = await api.post<{ key: string; ok: boolean; error?: string }[]>('/api/system/tuning', {});
              const failed = r.filter((x) => !x.ok);
              if (failed.length) toast.info(`${r.length - failed.length}개 적용, ${failed.length}개는 이 환경에서 바꿀 수 없음${container ? ' (LXC 는 호스트에서 설정)' : ''}`);
              else toast.ok('모두 적용했습니다 (/etc/sysctl.d/90-hrone.conf)');
              reload();
            })
          }
        >
          권장값 적용
        </Button>
      }
    >
      <div className="space-y-1.5 text-[13px]">
        {data.map((t) => (
          <div key={t.key} className="flex items-center gap-2">
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', ok(t) ? 'bg-ok' : 'bg-warn')} />
            <span className="mono min-w-0 flex-1 truncate" title={t.why}>
              {t.key}
            </span>
            <span className="mono text-xs text-muted">{t.current ?? '읽기 불가'}</span>
            {!ok(t) && <span className="mono text-xs text-warn">→ {t.value}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Swap() {
  const { data, reload } = useApi<{ list: { name: string; size: number; used: number }[]; managed: boolean; container: boolean }>('/api/system/swap');
  const [size, setSize] = useState('2048');
  const { busy, run } = useAction();
  const confirm = useConfirm();
  if (!data) return null;
  return (
    <Card title={<span className="flex items-center gap-2"><Layers size={16} /> 스왑</span>}>
      {data.list.length ? (
        <div className="mb-3 space-y-1 text-[13px]">
          {data.list.map((s) => (
            <div key={s.name} className="flex justify-between">
              <span className="mono">{s.name}</span>
              <span className="text-muted">
                {bytes(s.used)} / {bytes(s.size)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-3 text-sm text-muted">스왑이 없습니다. 메모리가 작은 VM 이라면 만들어 두면 OOM 을 줄일 수 있습니다.</div>
      )}
      {data.container ? (
        <div className="text-xs text-muted">LXC 에서는 컨테이너 안에서 스왑을 만들 수 없습니다. Proxmox 컨테이너 설정의 Swap 값을 올리세요.</div>
      ) : (
        <div className="flex items-center gap-2">
          <input className="input mono w-28" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, ''))} />
          <span className="text-sm text-muted">MB</span>
          <Button size="sm" loading={busy === 'c'} onClick={() => run('c', () => api.post('/api/system/swap', { sizeMB: Number(size) }).then(reload), '스왑을 만들었습니다')}>
            {data.managed ? '크기 변경' : '스왑 파일 만들기'}
          </Button>
          {data.managed && (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'r'}
              onClick={async () => {
                if (await confirm({ title: '스왑 제거', confirm: '제거' })) run('r', () => api.del('/api/system/swap').then(reload), '제거했습니다');
              }}
            >
              제거
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function Timezone({ current }: { current?: string }) {
  const { data: list } = useApi<string[]>('/api/system/timezones');
  const [tz, setTz] = useState(current ?? '');
  useEffect(() => setTz(current ?? ''), [current]);
  const { busy, run } = useAction();
  return (
    <Card title={<span className="flex items-center gap-2"><Globe size={16} /> 시간대</span>}>
      <div className="flex items-center gap-2">
        <select className="input" value={tz} onChange={(e) => setTz(e.target.value)}>
          {(list ?? [current ?? '']).map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
        <Button size="sm" disabled={tz === current} loading={busy === 'tz'} onClick={() => run('tz', () => api.put('/api/system/timezone', { timezone: tz }), '바꿨습니다. 예약 백업 시각이 이 시간대를 따릅니다.')}>
          적용
        </Button>
        {current !== 'Asia/Seoul' && (
          <Button size="sm" variant="ghost" onClick={() => setTz('Asia/Seoul')}>
            서울
          </Button>
        )}
      </div>
    </Card>
  );
}

function JournalCard() {
  const { data, reload } = useApi<{ usage: string }>('/api/system/journal');
  const { busy, run } = useAction();
  return (
    <Card title={<span className="flex items-center gap-2"><HardDrive size={16} /> 로그 저장소 (journald)</span>}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted">{data?.usage ?? '-'}</span>
        <Button size="sm" variant="ghost" loading={busy === 'v'} onClick={() => run('v', () => api.post('/api/system/journal/vacuum', { size: '500M' }).then(reload), '오래된 로그를 정리했습니다')}>
          500MB 까지 정리
        </Button>
      </div>
      <div className="hint">앱 콘솔 로그는 journald 에 저장되며 최대 2GB 를 넘으면 오래된 것부터 지워집니다 (/etc/systemd/journald.conf.d/hrone.conf).</div>
    </Card>
  );
}

function PanelUpdate({ version, node }: { version?: string; node?: string }) {
  const [check, setCheck] = useState<{ available: boolean; local?: string; remote?: string; branch?: string; commits?: { sha: string; message: string; when: string }[]; error?: string } | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  useEffect(() => {
    if (log === null) return;
    const t = setInterval(async () => {
      try {
        setLog((await api.get<{ log: string }>('/api/system/update/log')).log);
      } catch {
        /* 패널 재시작 중 */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [log === null]);
  return (
    <Card
      title={<span className="flex items-center gap-2"><RefreshCw size={16} /> HROne 업데이트</span>}
      actions={
        <span className="text-xs text-muted">
          v{version} · Node {node}
        </span>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted">패널만 업데이트되고 앱과 DB 는 계속 돌아갑니다 (각자 별도 systemd 서비스). 터미널에서는 sudo hrone update.</p>
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<RefreshCw size={15} />}
            loading={busy === 'c'}
            onClick={() =>
              run('c', async () => {
                const r = await api.get<typeof check>('/api/system/update/check');
                setCheck(r);
                if (r && !r.available && !r.error) toast.ok('최신 버전입니다');
              })
            }
          >
            업데이트 확인
          </Button>
          {check?.available && (
            <Button
              variant="primary"
              icon={<Download size={15} />}
              loading={busy === 'u'}
              onClick={async () => {
                if (!(await confirm({ title: 'HROne 업데이트', body: '최신 코드를 받아 빌드하고 패널을 재시작합니다 (1~3분). 그동안 패널 화면은 잠깐 끊깁니다.', confirm: '업데이트' }))) return;
                run('u', async () => {
                  await api.post('/api/system/update');
                  setLog('');
                });
              }}
            >
              지금 업데이트 ({check.commits?.length}개)
            </Button>
          )}
        </div>
        {check?.error && <div className="text-bad">{check.error}</div>}
        {check?.commits && check.commits.length > 0 && (
          <div className="space-y-1 rounded-xl border border-line bg-surface-2 p-3">
            {check.commits.map((c) => (
              <div key={c.sha} className="flex gap-2 text-[13px]">
                <span className="mono text-accent-2">{c.sha}</span>
                <span className="min-w-0 flex-1 truncate">{c.message}</span>
                <span className="text-xs text-muted">{c.when}</span>
              </div>
            ))}
          </div>
        )}
        {log !== null && <pre className="mono max-h-72 overflow-auto rounded-xl border border-line bg-code p-3 text-[12px] text-fg-2">{log || '시작하는 중...'}</pre>}
      </div>
    </Card>
  );
}
