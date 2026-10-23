import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import { useChannel } from '../lib/store';
import { Button, Field, Modal, Spinner, Toggle, cx } from './ui';

/**
 * 실수 방지 2단계 확인.
 *  1단계: 무엇이 지워지는지 확인 + 옵션 선택
 *  2단계: 대상 ID 를 직접 입력 + 비밀번호(+OTP) 재확인
 */
export function DangerDialog({
  open,
  onClose,
  title,
  target,
  items,
  options,
  needTotp,
  confirmLabel = '영구 삭제',
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  target: string;
  items: ReactNode[];
  options?: ReactNode;
  needTotp: boolean;
  confirmLabel?: string;
  onConfirm: (auth: { confirm: string; password: string; totp: string }) => Promise<void>;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setStep(1);
      setTyped('');
      setPassword('');
      setTotp('');
      setError('');
    }
  }, [open]);
  const ready = typed === target && password.length > 0 && (!needTotp || totp.length === 6);
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      dismissable={!busy}
      title={
        <span className="flex items-center gap-2 text-bad">
          <AlertTriangle size={18} /> {title}
        </span>
      }
      footer={
        step === 1 ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              취소
            </Button>
            <Button variant="danger" onClick={() => setStep(2)}>
              계속 (1/2)
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
              뒤로
            </Button>
            <Button
              variant="danger"
              disabled={!ready}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await onConfirm({ confirm: typed, password, totp });
                  onClose();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel} (2/2)
            </Button>
          </>
        )
      }
    >
      {step === 1 ? (
        <div className="space-y-4 text-sm">
          <p className="text-fg-2">되돌릴 수 없습니다. 아래 항목이 삭제됩니다.</p>
          <ul className="space-y-1.5 rounded-xl border border-bad/25 bg-bad/8 px-4 py-3">
            {items.map((it, i) => (
              <li key={i} className="flex gap-2 text-fg-2">
                <span className="text-bad">•</span>
                <span>{it}</span>
              </li>
            ))}
          </ul>
          {options && <div className="space-y-3">{options}</div>}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <Field label={<>확인을 위해 <code className="rounded bg-surface-3 px-1.5 py-0.5 text-bad">{target}</code> 를 입력하세요</>}>
            <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="비밀번호 재확인">
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          {needTotp && (
            <Field label="OTP 코드">
              <input className="input mono tracking-[0.3em]" inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} />
            </Field>
          )}
          {error && <div className="rounded-lg bg-bad/10 px-3 py-2 text-bad">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

/** 비밀번호(+OTP) 만 다시 묻는 확인창 (복원 등) */
export function ReauthDialog({
  open,
  onClose,
  title,
  body,
  needTotp,
  confirmLabel = '확인',
  danger,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body?: ReactNode;
  needTotp: boolean;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: (auth: { password: string; totp: string }) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setPassword('');
      setTotp('');
      setError('');
    }
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={!password || (needTotp && totp.length !== 6)}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onConfirm({ password, totp });
                onClose();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {body && <div className="leading-relaxed text-fg-2">{body}</div>}
        <Field label="비밀번호">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        {needTotp && (
          <Field label="OTP 코드">
            <input className="input mono tracking-[0.3em]" inputMode="numeric" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
        {error && <div className="rounded-lg bg-bad/10 px-3 py-2 text-bad">{error}</div>}
      </div>
    </Modal>
  );
}

interface Job {
  id: number;
  title: string;
  status: 'running' | 'done' | 'failed';
  lines: string[];
  error: string | null;
}

/** 오래 걸리는 작업 진행 상황 */
export function JobDialog({ jobId, onClose, onDone }: { jobId: number | null; onClose: () => void; onDone?: (ok: boolean) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  useEffect(() => {
    if (!jobId) return;
    doneRef.current = false;
    setJob(null);
    api.get<Job>(`/api/jobs/${jobId}`).then(setJob).catch(() => {});
  }, [jobId]);
  useChannel(jobId ? `job:${jobId}` : null, (d: { line?: string; done?: boolean; status?: Job['status']; error?: string }) => {
    setJob((j) => {
      if (!j) return j;
      if (d.line !== undefined) return { ...j, lines: [...j.lines, d.line] };
      if (d.done) return { ...j, status: d.status!, error: d.error ?? null };
      return j;
    });
  });
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
    if (job && job.status !== 'running' && !doneRef.current) {
      doneRef.current = true;
      onDone?.(job.status === 'done');
    }
  }, [job, onDone]);
  const running = !job || job.status === 'running';
  return (
    <Modal
      open={!!jobId}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {running ? <Spinner size={16} /> : job.status === 'done' ? <CheckCircle2 size={17} className="text-ok" /> : <XCircle size={17} className="text-bad" />}
          {job?.title ?? '작업'}
        </span>
      }
      width={640}
      footer={<Button onClick={onClose}>{running ? '백그라운드에서 계속' : '닫기'}</Button>}
    >
      <div ref={box} className="mono h-72 overflow-auto rounded-xl border border-line bg-[#07090d] p-3 text-[12px] leading-relaxed whitespace-pre-wrap break-all text-fg-2">
        {(job?.lines ?? []).map((l, i) => (
          <div key={i} className={cx(l.startsWith('오류') && 'text-bad', (l === '완료' || l.endsWith('완료')) && 'text-ok')}>
            {l}
          </div>
        ))}
        {running && <div className="pulse text-muted">▍</div>}
      </div>
    </Modal>
  );
}

export function OptionToggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; sub?: ReactNode }) {
  return <Toggle {...props} />;
}
