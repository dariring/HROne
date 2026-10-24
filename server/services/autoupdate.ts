import { getSetting, q, setSetting } from '../lib/db.ts';
import { tryRun } from '../lib/exec.ts';
import { errMsg, log } from '../lib/log.ts';
import { ROOT } from '../lib/paths.ts';
import { HttpError } from '../lib/util.ts';
import { listJobs } from './jobs.ts';
import { notify } from './notify.ts';
import { runUpdate, updateCheck } from './system.ts';

/**
 * HROne 패널 자동 업데이트.
 * 정해진 주기마다 GitHub 를 확인하고 새 커밋이 있으면 업데이트한다.
 * 앱/DB 는 별도 systemd 서비스라 그대로 돌고, 패널만 재시작된다.
 * 패널 안에서 돌던 배포·백업은 재시작 때 끊기므로, 그런 작업이 있으면 끝날 때까지 미룬다.
 */

export interface AutoUpdateSettings {
  enabled: boolean;
  intervalHours: number;
}

export interface AutoUpdateState {
  lastCheckAt: number | null;
  /** 작업 중이라 미뤘을 때 다시 볼 시각 (주기를 다 기다리지 않는다) */
  retryAt: number | null;
  /** latest = 최신, updating = 업데이트 시작함, busy = 작업 중이라 미룸, error = 확인 실패 */
  lastResult: 'latest' | 'updating' | 'busy' | 'error' | null;
  message: string;
  /** 업데이트를 시작한 뒤 재시작을 기다리는 중 */
  pending: { from: string; to: string; at: number; by: string } | null;
  lastUpdate: { from: string; to: string; at: number; by: string } | null;
}

const INTERVALS = [1, 6, 24];
const BUSY_RETRY_MS = 10 * 60_000;
const PENDING_TIMEOUT_MS = 20 * 60_000;

export function autoUpdateSettings(): AutoUpdateSettings {
  const s = getSetting<AutoUpdateSettings>('auto_update', { enabled: true, intervalHours: 6 });
  return { enabled: !!s.enabled, intervalHours: INTERVALS.includes(s.intervalHours) ? s.intervalHours : 6 };
}

export function setAutoUpdateSettings(v: Partial<AutoUpdateSettings>) {
  const cur = autoUpdateSettings();
  const next = { enabled: v.enabled ?? cur.enabled, intervalHours: v.intervalHours ?? cur.intervalHours };
  if (!INTERVALS.includes(next.intervalHours)) throw new HttpError(400, `확인 주기는 ${INTERVALS.join(' / ')}시간 중 하나입니다`);
  setSetting('auto_update', next);
  return next;
}

export function autoUpdateState(): AutoUpdateState {
  return getSetting<AutoUpdateState>('auto_update_state', { lastCheckAt: null, retryAt: null, lastResult: null, message: '', pending: null, lastUpdate: null });
}

function patchState(p: Partial<AutoUpdateState>) {
  setSetting('auto_update_state', { ...autoUpdateState(), ...p });
}

/** 지금 업데이트하면 끊길 작업이 있으면 그 이유 */
export function busyReason(): string | null {
  const deploys = q.get<{ n: number }>(`SELECT COUNT(*) n FROM deploys WHERE status IN ('running', 'queued')`)!.n;
  if (deploys) return `배포 ${deploys}개가 진행 중`;
  const job = listJobs().find((j) => j.status === 'running');
  if (job) return `"${job.title}" 작업이 진행 중`;
  const backups = q.get<{ n: number }>(`SELECT COUNT(*) n FROM backups WHERE status = 'running'`)!.n;
  if (backups) return '백업이 진행 중';
  return null;
}

export async function currentCommit() {
  const r = await tryRun('git', ['log', '-1', '--format=%h%x1f%s%x1f%ct'], { cwd: ROOT, env: { HOME: '/root' } });
  const [sha = '', message = '', ct = '0'] = r.stdout.trim().split('\x1f');
  return { sha, message, date: Number(ct) * 1000 || null };
}

const short = (sha: string) => sha.slice(0, 7);

/** 업데이트 시작 (수동/자동 공통). 끊길 작업이 있으면 409 */
export async function startUpdate(by: string) {
  const busy = busyReason();
  if (busy) throw new HttpError(409, `${busy}입니다. 끝난 뒤에 업데이트하세요.`);
  const check = await updateCheck();
  const from = (await currentCommit()).sha;
  patchState({ lastResult: 'updating', message: '업데이트 중', pending: { from, to: check.remote ? short(check.remote) : '', at: Date.now(), by } });
  try {
    await runUpdate();
  } catch (e) {
    patchState({ lastResult: 'error', message: `업데이트를 시작하지 못했습니다: ${errMsg(e)}`, pending: null });
    throw e;
  }
}

let checking = false;

/** 1분마다 불린다 */
export async function autoUpdateTick() {
  if (checking) return;
  const st = autoUpdateState();
  // 업데이트를 시작했는데 한참 지나도 재시작되지 않았으면 실패로 본다
  if (st.pending && Date.now() - st.pending.at > PENDING_TIMEOUT_MS) {
    patchState({ lastResult: 'error', message: '업데이트가 끝나지 않았습니다. 설정 → 업데이트의 로그를 확인하세요.', pending: null });
    void notify({ kind: 'panel', title: '⚠️ HROne 업데이트 실패', description: '업데이트가 끝나지 않았습니다. 패널은 예전 버전으로 계속 동작합니다.', color: 'red', path: '/settings?tab=update' });
    return;
  }
  const s = autoUpdateSettings();
  if (!s.enabled || st.pending) return;
  // 막 켜진 직후에는 쉬었다가
  if (process.uptime() < 180) return;
  const next = st.retryAt ?? (st.lastCheckAt ? st.lastCheckAt + s.intervalHours * 3600_000 : 0);
  if (Date.now() < next) return;
  checking = true;
  try {
    const r = await updateCheck();
    if (r.error) {
      patchState({ lastCheckAt: Date.now(), retryAt: null, lastResult: 'error', message: r.error });
      return;
    }
    if (!r.available) {
      patchState({ lastCheckAt: Date.now(), retryAt: null, lastResult: 'latest', message: '최신 버전입니다' });
      return;
    }
    const busy = busyReason();
    if (busy) {
      // 주기를 다 기다리지 않고 10분 뒤 다시 본다
      patchState({ lastCheckAt: Date.now(), retryAt: Date.now() + BUSY_RETRY_MS, lastResult: 'busy', message: `새 버전이 있지만 ${busy}이라 끝난 뒤에 업데이트합니다` });
      return;
    }
    patchState({ lastCheckAt: Date.now(), retryAt: null });
    log.info(`자동 업데이트: ${short(r.local ?? '')} → ${short(r.remote ?? '')}`);
    await notify({
      kind: 'panel',
      title: '🔄 HROne 자동 업데이트 시작',
      description: `${r.commits?.slice(0, 10).map((c) => `• ${c.message}`).join('\n') ?? ''}\n\n앱과 DB 는 계속 실행됩니다.`,
      color: 'blue',
      path: '/settings?tab=update',
    });
    await startUpdate('자동');
  } catch (e) {
    patchState({ lastCheckAt: Date.now(), retryAt: null, lastResult: 'error', message: errMsg(e) });
    log.warn(`자동 업데이트: ${errMsg(e)}`);
  } finally {
    checking = false;
  }
}

/** 패널이 켜질 때: 업데이트 뒤 재시작이면 결과를 남기고 알린다 */
export async function autoUpdateOnBoot() {
  const st = autoUpdateState();
  if (!st.pending) return;
  const now = await currentCommit();
  if (now.sha && now.sha !== st.pending.from) {
    patchState({ pending: null, lastResult: 'latest', message: '업데이트 완료', lastUpdate: { ...st.pending, to: now.sha, at: Date.now() } });
    void notify({ kind: 'panel', title: '✅ HROne 업데이트 완료', description: `${st.pending.from} → ${now.sha}\n${now.message}`, color: 'green', path: '/settings?tab=update' });
  }
}
