import { Boxes, ChevronRight, ExternalLink, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { AppPower, modeText } from '../components/shared';
import { Badge, Button, Empty, ErrorBox, Loading, PageHeader, StatusBadge, cx } from '../components/ui';
import { ago, bytes, pct, sha } from '../lib/format';
import { Link, navigate, useTitle } from '../lib/router';
import { useApi, useLive } from '../lib/store';
import { RuntimeIcon, type AppSummary } from './Dashboard';

// 이름 · 상태 · 주소 · 사용량 · 배포 (오른쪽 버튼 칸은 따로)
const COLS = 'lg:grid-cols-[minmax(0,2fr)_104px_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)]';

export function Apps() {
  useTitle('앱');
  const live = useLive();
  const { data, error, loading, reload } = useApi<AppSummary[]>('/api/apps', { refreshOn: ['apps', 'deploys'] });
  const [q, setQ] = useState('');
  const list = (data ?? []).filter((a) => !q || `${a.name} ${a.slug} ${a.repoUrl}`.toLowerCase().includes(q.toLowerCase()));
  const stateOf = (a: AppSummary) => (a.deployedSha ? (live.units[`hrone-app-${a.slug}.service`] ?? a.status)?.state : 'not-deployed');
  const running = (data ?? []).filter((a) => stateOf(a) === 'running').length;

  return (
    <div>
      <PageHeader
        title="앱"
        sub={data?.length ? `${data.length}개 · 실행 중 ${running}개` : 'GitHub 에 푸시하면 자동으로 배포되는 Node.js · Python 앱'}
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
          <div className="card overflow-hidden">
            <div className="hidden items-center gap-4 border-b border-line bg-surface-2/60 px-5 py-2 text-xs font-medium text-muted lg:flex">
              <div className={cx('grid flex-1 gap-4', COLS)}>
                <span>이름</span>
                <span>상태</span>
                <span>주소</span>
                <span>사용량</span>
                <span>배포</span>
              </div>
              <span className="w-[176px]" />
            </div>
            {list.length === 0 && <div className="px-5 py-8 text-center text-sm text-muted">"{q}" 와 맞는 앱이 없습니다</div>}
            <div className="divide-y divide-line">
              {list.map((a) => (
                <AppRow key={a.slug} a={a} st={live.units[`hrone-app-${a.slug}.service`] ?? a.status} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AppRow({ a, st }: { a: AppSummary; st: AppSummary['status'] }) {
  const state = a.deployedSha ? st?.state : 'not-deployed';
  const usage = st?.state === 'running' ? `CPU ${pct(st.cpu, 1)} · ${bytes(st.memory)}` : null;
  const address = a.publicUrl ? a.publicUrl.replace(/^https?:\/\//, '') : a.port ? `127.0.0.1:${a.port}` : '포트 없음';
  // IP:포트만 고정폭 글꼴로 (한글이 섞이면 간격이 어색하다)
  const addrMono = !a.publicUrl && !!a.port;
  // 지금 눈여겨볼 배포 상태가 있으면 그것을, 없으면 마지막 배포 시각
  const deploy =
    a.openDeploy?.status === 'pending' ? (
      <Badge tone="yellow">승인 대기</Badge>
    ) : a.openDeploy?.status === 'scheduled' ? (
      <Badge tone="blue">배포 예약됨</Badge>
    ) : a.busy ? (
      <Badge tone="purple">배포 중</Badge>
    ) : a.lastPollError ? (
      <Badge tone="red">저장소 확인 실패</Badge>
    ) : (
      <span className="text-fg-2">{a.deployedAt ? `${ago(a.deployedAt)} · ${sha(a.deployedSha)}` : '배포 전'}</span>
    );

  return (
    <div className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-surface-2/60">
      <Link to={`/apps/${a.slug}`} className={cx('grid min-w-0 flex-1 items-center gap-x-4 gap-y-1', COLS)}>
        <div className="flex min-w-0 items-center gap-3">
          <RuntimeIcon runtime={a.runtime} size={34} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{a.name}</span>
              <span className="lg:hidden">
                <StatusBadge state={state} />
              </span>
            </div>
            <div className="truncate text-xs text-muted">
              {a.repoUrl.replace(/^https?:\/\/(github\.com\/)?|^git@github\.com:|\.git$/g, '')} · {a.branch}
            </div>
            {/* 좁은 화면에서는 나머지 칸 대신 한 줄 요약 */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted lg:hidden">
              <span className={cx(addrMono && 'mono')}>{address}</span>
              {usage && <span>{usage}</span>}
              {deploy}
            </div>
          </div>
        </div>
        <div className="hidden lg:block">
          <StatusBadge state={state} />
        </div>
        <div className="hidden min-w-0 lg:block">
          <div className={cx('truncate text-[13px] text-fg-2', addrMono && 'mono')}>{address}</div>
          {!a.autostart && <div className="text-xs text-muted">자동 시작 꺼짐</div>}
        </div>
        <div className="hidden text-[13px] text-fg-2 lg:block">{usage ?? <span className="text-muted">-</span>}</div>
        <div className="hidden min-w-0 text-[13px] lg:block">
          <div className="truncate">{deploy}</div>
          <div className="truncate text-xs text-muted">{modeText(a.deployMode, a.deployDelaySec)}</div>
        </div>
      </Link>
      <div className="flex shrink-0 items-center justify-end gap-1 lg:w-[176px]">
        {a.publicUrl && (
          <a href={a.publicUrl} target="_blank" rel="noreferrer" title={a.publicUrl} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg">
            <ExternalLink size={15} />
          </a>
        )}
        <span className="hidden sm:block">
          <AppPower slug={a.slug} state={st?.state} deployed={!!a.deployedSha} />
        </span>
        <Link to={`/apps/${a.slug}`} className="text-muted sm:hidden" aria-label={`${a.name} 열기`}>
          <ChevronRight size={18} />
        </Link>
      </div>
    </div>
  );
}
