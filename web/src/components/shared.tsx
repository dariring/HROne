import { Check, Clock, Play, RotateCw, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { delayText, sha } from '../lib/format';
import type { RunState } from '../lib/store';
import { Badge, Button, cx, toast, useAction, useConfirm } from './ui';

export type DeployStatus = 'pending' | 'scheduled' | 'queued' | 'running' | 'success' | 'failed' | 'rolled_back' | 'rejected' | 'cancelled' | 'superseded';

export interface Commit {
  sha: string;
  author: string;
  date: number;
  message: string;
}

export interface Deploy {
  id: number;
  app_id: number;
  trigger: 'push' | 'webhook' | 'manual' | 'rollback' | 'initial' | 'config';
  status: DeployStatus;
  from_sha: string | null;
  to_sha: string | null;
  commits: Commit[];
  scheduled_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  triggered_by: string | null;
  approved_by: string | null;
  error: string | null;
  appSlug?: string;
  appName?: string;
}

const DS: Record<DeployStatus, { label: string; tone: 'gray' | 'green' | 'red' | 'yellow' | 'blue' | 'purple' }> = {
  pending: { label: '승인 대기', tone: 'yellow' },
  scheduled: { label: '예약됨', tone: 'blue' },
  queued: { label: '대기열', tone: 'blue' },
  running: { label: '배포 중', tone: 'purple' },
  success: { label: '성공', tone: 'green' },
  failed: { label: '실패', tone: 'red' },
  rolled_back: { label: '실패 · 롤백됨', tone: 'red' },
  rejected: { label: '거절됨', tone: 'gray' },
  cancelled: { label: '취소됨', tone: 'gray' },
  superseded: { label: '건너뜀', tone: 'gray' },
};

export function DeployBadge({ status }: { status: DeployStatus }) {
  const s = DS[status];
  return <Badge tone={s.tone}>{status === 'running' && <span className="pulse h-1.5 w-1.5 rounded-full bg-accent-2" />}{s.label}</Badge>;
}

export const TRIGGER: Record<Deploy['trigger'], string> = {
  push: '푸시 감지',
  webhook: '웹후크',
  manual: '수동 배포',
  rollback: '롤백',
  initial: '첫 배포',
  config: '설정 변경',
};

export function Countdown({ at }: { at: number }) {
  const [, setT] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((at - Date.now()) / 1000));
  return <span className="mono">{left >= 60 ? `${Math.floor(left / 60)}분 ${left % 60}초` : `${left}초`}</span>;
}

/** 승인 대기 / 예약 배포 카드 내용 + 버튼 */
export function PendingDeploy({ d, compact }: { d: Deploy; compact?: boolean }) {
  const { busy, run } = useAction();
  const head = d.commits[0];
  return (
    <div className={cx('flex flex-col gap-3 sm:flex-row sm:items-center', !compact && 'py-1')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {d.appName && <span className="font-semibold">{d.appName}</span>}
          <DeployBadge status={d.status} />
          <span className="mono text-xs text-muted">
            {sha(d.from_sha)} → {sha(d.to_sha)}
          </span>
          {d.commits.length > 1 && <span className="text-xs text-muted">커밋 {d.commits.length}개</span>}
        </div>
        {head && <div className="mt-1 truncate text-sm text-fg-2">{head.message} <span className="text-muted">— {head.author}</span></div>}
        {d.status === 'scheduled' && d.scheduled_at && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-info">
            <Clock size={12} /> <Countdown at={d.scheduled_at} /> 뒤 자동 적용
          </div>
        )}
      </div>
      {(d.status === 'pending' || d.status === 'scheduled' || d.status === 'queued') && (
        <div className="flex shrink-0 gap-2">
          {d.status !== 'queued' && (
            <Button size="sm" variant="success" icon={<Check size={14} />} loading={busy === 'ok'} onClick={() => run('ok', () => api.post(`/api/deploys/${d.id}/approve`), d.status === 'pending' ? '승인했습니다. 배포를 시작합니다.' : '바로 적용합니다')}>
              {d.status === 'pending' ? '승인' : '지금 적용'}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<X size={14} />} loading={busy === 'no'} onClick={() => run('no', () => api.post(`/api/deploys/${d.id}/reject`), d.status === 'pending' ? '거절했습니다' : '취소했습니다')}>
            {d.status === 'pending' ? '거절' : '취소'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 시작/정지/재시작 버튼 묶음 */
export function AppPower({ slug, state, deployed, size = 'sm' }: { slug: string; state: RunState | null | undefined; deployed: boolean; size?: 'sm' | 'md' }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const act = (a: string, msg: string) => run(a, () => api.post(`/api/apps/${slug}/action`, { action: a }), msg);
  const on = state === 'running' || state === 'starting' || state === 'restarting';
  if (!deployed) return null;
  return (
    <div className="flex gap-1.5">
      {!on ? (
        <Button size={size} variant="success" icon={<Play size={14} />} loading={busy === 'start'} onClick={() => act('start', '시작했습니다')}>
          시작
        </Button>
      ) : (
        <Button
          size={size}
          variant="secondary"
          icon={<Square size={13} />}
          loading={busy === 'stop'}
          onClick={async () => {
            if (await confirm({ title: '앱 정지', body: '앱을 정지합니다. 자동 배포는 코드만 받아 두고 시작하지 않습니다.', confirm: '정지' })) act('stop', '정지했습니다');
          }}
        >
          정지
        </Button>
      )}
      <Button size={size} variant="secondary" icon={<RotateCw size={14} />} loading={busy === 'restart'} onClick={() => act('restart', '재시작했습니다')}>
        재시작
      </Button>
    </div>
  );
}

export function modeText(mode: 'auto' | 'delay' | 'manual', delay: number) {
  return mode === 'auto' ? '바로 배포' : mode === 'delay' ? `${delayText(delay)} 뒤 배포` : '승인 후 배포';
}

export function copyText(text: string, label = '복사했습니다') {
  navigator.clipboard?.writeText(text).then(() => toast.ok(label));
}
