import { Archive, Download, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { JobDialog, ReauthDialog } from '../components/Dialogs';
import type { Me } from '../components/Layout';
import { Badge, Empty, IconButton, Loading, Segmented, toast, useConfirm } from '../components/ui';
import { api } from '../lib/api';
import { bytes, dateTime } from '../lib/format';
import { Link } from '../lib/router';
import { useApi } from '../lib/store';

export interface Backup {
  id: number;
  kind: 'database' | 'app';
  target_slug: string;
  file: string;
  size: number;
  trigger: 'manual' | 'schedule' | 'predeploy' | 'terminate';
  status: 'running' | 'done' | 'failed';
  note: string | null;
  created_at: number;
}

const TRIG: Record<Backup['trigger'], string> = { manual: '수동', schedule: '예약', predeploy: '배포 전', terminate: '삭제 전 최종' };

export function BackupList({ list, me, reload, showTarget }: { list: Backup[]; me: Me; reload: () => void; showTarget?: boolean }) {
  const confirm = useConfirm();
  const [restore, setRestore] = useState<Backup | null>(null);
  const [job, setJob] = useState<number | null>(null);
  if (!list.length) return <div className="card"><Empty icon={<Archive size={22} />} title="백업이 없습니다" /></div>;
  return (
    <>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-5 py-2.5 font-medium">시각</th>
              {showTarget && <th className="px-3 py-2.5 font-medium">대상</th>}
              <th className="px-3 py-2.5 font-medium">종류</th>
              <th className="px-3 py-2.5 font-medium">크기</th>
              <th className="px-3 py-2.5 font-medium">상태</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((b) => (
              <tr key={b.id} className="hover:bg-surface-2/50">
                <td className="mono px-5 py-2.5 text-[13px]">{dateTime(b.created_at)}</td>
                {showTarget && (
                  <td className="px-3 py-2.5">
                    <Link to={b.kind === 'app' ? `/apps/${b.target_slug}?tab=settings` : `/databases/${b.target_slug}?tab=backups`} className="hover:underline">
                      {b.target_slug}
                    </Link>{' '}
                    <span className="text-xs text-muted">{b.kind === 'app' ? '앱' : 'DB'}</span>
                  </td>
                )}
                <td className="px-3 py-2.5">
                  <Badge tone={b.trigger === 'terminate' ? 'yellow' : b.trigger === 'schedule' ? 'blue' : 'gray'}>{TRIG[b.trigger]}</Badge>
                  {b.note && b.status !== 'failed' && <span className="ml-2 text-xs text-muted">{b.note}</span>}
                </td>
                <td className="px-3 py-2.5 text-fg-2">{b.status === 'done' ? bytes(b.size) : '-'}</td>
                <td className="px-3 py-2.5">
                  {b.status === 'done' ? <Badge tone="green">완료</Badge> : b.status === 'running' ? <Badge tone="blue">진행 중</Badge> : <Badge tone="red">실패</Badge>}
                  {b.status === 'failed' && b.note && <div className="mt-1 max-w-xs truncate text-xs text-bad" title={b.note}>{b.note}</div>}
                </td>
                <td className="px-5 py-2.5">
                  <div className="flex items-center justify-end gap-0.5">
                    {b.status === 'done' && (
                      <>
                        <a href={`/api/backups/${b.id}/download`} className="mr-1 inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-fill px-2.5 text-[13px] font-medium text-fg hover:bg-fill-strong/50">
                          <Download size={14} />
                          내려받기
                        </a>
                        <IconButton title="복원" onClick={() => setRestore(b)}>
                          <RotateCcw size={15} />
                        </IconButton>
                      </>
                    )}
                    <IconButton
                      title="삭제"
                      onClick={async () => {
                        if (!(await confirm({ title: '백업 삭제', body: `${dateTime(b.created_at)} 백업 파일을 지웁니다.`, confirm: '삭제', danger: true }))) return;
                        try {
                          await api.del(`/api/backups/${b.id}`);
                          reload();
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReauthDialog
        open={!!restore}
        onClose={() => setRestore(null)}
        title="백업 복원"
        danger
        confirmLabel="복원"
        needTotp={me.totpEnabled}
        body={
          restore && (
            <>
              <b className="text-fg">{dateTime(restore.created_at)}</b> 백업으로 <b className="text-fg">{restore.target_slug}</b> 를 되돌립니다.{' '}
              {restore.kind === 'database' ? 'DB 는 복원 동안 잠깐 멈추거나 느려질 수 있습니다.' : '백업에 들어 있는 파일을 덮어씁니다.'} 복원 직전 상태는 자동으로 한 번 더 백업됩니다.
            </>
          )
        }
        onConfirm={async (auth) => {
          const r = await api.post<{ jobId: number }>(`/api/backups/${restore!.id}/restore`, auth);
          setJob(r.jobId);
        }}
      />
      <JobDialog jobId={job} onClose={() => setJob(null)} onDone={reload} />
    </>
  );
}

/** 서버 → 백업 탭: 모든 앱/DB 의 백업 */
export function BackupsPanel({ me }: { me: Me }) {
  const [kind, setKind] = useState<'all' | 'database' | 'app'>('all');
  const { data, loading, reload } = useApi<Backup[]>('/api/backups', { refreshOn: ['backups'] });
  const list = (data ?? []).filter((b) => kind === 'all' || b.kind === kind);
  const total = list.filter((b) => b.status === 'done').reduce((a, b) => a + b.size, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          DB 는 매일 04:00 에 자동으로 백업하고 7개를 보관합니다. 앱 데이터(SQLite 등)는 앱 설정 → 백업에서 켤 수 있습니다. 합계 {bytes(total)}
        </p>
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: '전체' },
            { value: 'database', label: 'DB' },
            { value: 'app', label: '앱' },
          ]}
        />
      </div>
      {loading && !data ? <Loading /> : <BackupList list={list} me={me} reload={reload} showTarget />}
    </div>
  );
}
