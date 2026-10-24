import { Boxes, ExternalLink, GitBranch, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { AppPower, modeText } from '../components/shared';
import { Badge, Button, Empty, ErrorBox, Loading, PageHeader, StatusBadge } from '../components/ui';
import { ago, bytes, pct, sha } from '../lib/format';
import { Link, navigate, useTitle } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import { RuntimeIcon, type AppSummary } from './Dashboard';

export function Apps() {
  useTitle('앱');
  const live = useLive();
  const { data, error, loading, reload } = useApi<AppSummary[]>('/api/apps', { refreshOn: ['apps', 'deploys'] });
  const [q, setQ] = useState('');
  const list = (data ?? []).filter((a) => !q || `${a.name} ${a.slug} ${a.repoUrl}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <PageHeader
        title="앱"
        sub="GitHub 에 푸시하면 자동으로 배포되는 Node.js · Python 앱"
        actions={
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/apps/new')}>
            앱 추가
          </Button>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data ? (
        <Loading />
      ) : !data?.length ? (
        <div className="card">
          <Empty icon={<Boxes size={24} />} title="아직 앱이 없습니다" action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/apps/new')}>앱 추가</Button>}>
            GitHub 저장소 주소만 넣으면 실행 방법을 알아서 찾고, 이후 푸시할 때마다 자동으로 배포합니다.
          </Empty>
        </div>
      ) : (
        <>
          {data.length > 4 && (
            <div className="relative mb-4 max-w-sm">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input className="input pl-9" placeholder="앱 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {list.map((a) => {
              const st = live.units[`hrone-app-${a.slug}.service`] ?? a.status;
              return (
                <div key={a.slug} className="card flex flex-col p-5 transition-colors hover:border-line-2">
                  <Link to={`/apps/${a.slug}`} className="flex items-start gap-3">
                    <RuntimeIcon runtime={a.runtime} size={40} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[15px] font-semibold">{a.name}</span>
                        <StatusBadge state={a.deployedSha ? st?.state : 'not-deployed'} />
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted">{a.repoUrl.replace(/^https?:\/\/|\.git$/g, '')}</div>
                    </div>
                  </Link>
                  <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div>
                      <div className="text-muted">포트</div>
                      <div className="mono mt-0.5">127.0.0.1:{a.port}</div>
                    </div>
                    <div>
                      <div className="text-muted">배포</div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <GitBranch size={12} className="text-muted" />
                        {a.branch} <span className="mono text-muted">{sha(a.deployedSha)}</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-muted">사용량</div>
                      <div className="mt-0.5">{st?.state === 'running' ? `CPU ${pct(st.cpu, 1)} · ${bytes(st.memory)}` : '-'}</div>
                    </div>
                    <div>
                      <div className="text-muted">푸시하면</div>
                      <div className="mt-0.5">{modeText(a.deployMode, a.deployDelaySec)}</div>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
                    {a.openDeploy?.status === 'pending' && <Badge tone="yellow">승인 대기</Badge>}
                    {a.openDeploy?.status === 'scheduled' && <Badge tone="blue">배포 예약됨</Badge>}
                    {a.busy && <Badge tone="purple">배포 중</Badge>}
                    {!a.autostart && <Badge>자동 시작 꺼짐</Badge>}
                    {a.lastPollError && <Badge tone="red">저장소 확인 실패</Badge>}
                    {!a.busy && !a.openDeploy && a.deployedAt && <span className="text-xs text-muted">{ago(a.deployedAt)} 배포</span>}
                    <div className="ml-auto flex items-center gap-1.5">
                      {a.publicUrl && (
                        <a href={a.publicUrl} target="_blank" rel="noreferrer" title={a.publicUrl} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg">
                          <ExternalLink size={15} />
                        </a>
                      )}
                      <AppPower slug={a.slug} state={st?.state} deployed={!!a.deployedSha} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
