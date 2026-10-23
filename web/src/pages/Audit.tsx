import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { useTitle } from '../lib/router';

interface Row {
  id: number;
  ts: number;
  username: string;
  ip: string;
  action: string;
  target: string;
  detail: string;
}

const LABEL: Record<string, string> = {
  'auth.login': '로그인',
  'auth.login_failed': '로그인 실패',
  'auth.password_change': '비밀번호 변경',
  'auth.totp_enable': 'OTP 켬',
  'auth.totp_disable': 'OTP 끔',
  'user.create': '관리자 추가',
  'user.delete': '관리자 삭제',
  'app.create': '앱 생성',
  'app.update': '앱 설정 변경',
  'app.env': '환경변수 변경',
  'app.start': '앱 시작',
  'app.stop': '앱 정지',
  'app.restart': '앱 재시작',
  'app.kill': '앱 강제 종료',
  'app.autostart': '자동 시작 변경',
  'app.terminate': '앱 삭제',
  'app.link': 'DB 연결',
  'app.unlink': 'DB 연결 해제',
  'app.secrets': '앱 비밀값 변경',
  'app.deploykey': '배포 키 재생성',
  'app.restore': '앱 데이터 복원',
  'deploy.manual': '수동 배포',
  'deploy.initial': '첫 배포',
  'deploy.rollback': '롤백',
  'deploy.config': '설정 변경 배포',
  'deploy.approve': '배포 승인',
  'deploy.reject': '배포 거절',
  'deploy.cancel': '배포 취소',
  'db.create': 'DB 생성',
  'db.update': 'DB 설정 변경',
  'db.start': 'DB 시작',
  'db.stop': 'DB 정지',
  'db.restart': 'DB 재시작',
  'db.limits': 'DB 제한 변경',
  'db.reveal': 'DB 비밀번호 열람',
  'db.password': 'DB 비밀번호 변경',
  'db.query': 'DB 쿼리 실행',
  'db.terminate': 'DB 삭제',
  'db.restore': 'DB 복원',
  'db.schema_create': '스키마 생성',
  'db.schema_drop': '스키마 삭제',
  'db.user_create': 'DB 계정 생성',
  'db.user_drop': 'DB 계정 삭제',
  'db.flush_hosts': 'FLUSH HOSTS',
  'backup.create': '백업 생성',
  'backup.delete': '백업 삭제',
  'backup.download': '백업 내려받기',
  'system.limits': '전체 상한 변경',
  'system.tuning': '커널 튜닝',
  'system.update': '패널 업데이트',
  'system.install': '구성 요소 설치',
  'system.timezone': '시간대 변경',
  'settings.update': '설정 변경',
  'hook.bad_signature': '잘못된 웹후크 서명',
};

const TONE = (a: string) => (/terminate|delete|drop|failed|bad_signature|kill/.test(a) ? 'red' : /restore|reveal|password|totp/.test(a) ? 'yellow' : /deploy|create/.test(a) ? 'purple' : 'gray');

export function Audit() {
  useTitle('활동 기록');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = async (before?: number) => {
    setBusy(true);
    try {
      const r = await api.get<Row[]>(`/api/audit?limit=100${before ? `&before=${before}` : ''}`);
      setRows((x) => (before ? [...(x ?? []), ...r] : r));
      setMore(r.length === 100);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  return (
    <div>
      <PageHeader title="활동 기록" sub="누가 언제 무엇을 했는지 (최근 2만 건)" />
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty icon={<Activity size={22} />} title="기록이 없습니다" />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-5 py-2.5 font-medium">시각</th>
                <th className="px-3 py-2.5 font-medium">계정</th>
                <th className="px-3 py-2.5 font-medium">작업</th>
                <th className="px-3 py-2.5 font-medium">대상</th>
                <th className="px-5 py-2.5 font-medium">내용</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-surface-2/50">
                  <td className="mono whitespace-nowrap px-5 py-2 text-[12.5px] text-fg-2">{dateTime(r.ts)}</td>
                  <td className="px-3 py-2">
                    <div>{r.username}</div>
                    {r.ip && <div className="mono text-xs text-muted">{r.ip}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={TONE(r.action)}>{LABEL[r.action] ?? r.action}</Badge>
                  </td>
                  <td className="mono px-3 py-2 text-[12.5px]">{r.target || '-'}</td>
                  <td className="mono max-w-md truncate px-5 py-2 text-xs text-muted" title={r.detail}>
                    {r.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more && (
            <div className="border-t border-line p-3 text-center">
              <Button size="sm" variant="ghost" loading={busy} onClick={() => load(rows[rows.length - 1]!.id)}>
                더 보기
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
