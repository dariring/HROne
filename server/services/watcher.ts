import { now, q } from '../lib/db.ts';
import { bus } from '../lib/events.ts';
import { errMsg } from '../lib/log.ts';
import type { App } from '../lib/types.ts';
import { appIdentity, getApp, gitAuthFor, listApps } from './apps.ts';
import { onRemoteUpdate } from './deploy.ts';
import * as git from './git.ts';

const inflight = new Set<number>();

/** 원격 브랜치 확인. 바뀌었으면 배포 흐름으로 */
export async function checkApp(app: App, source: 'push' | 'webhook' = 'push') {
  if (inflight.has(app.id)) return null;
  inflight.add(app.id);
  try {
    const sha = await git.lsRemote(app.config.repoUrl, app.config.branch, { id: appIdentity(app), auth: gitAuthFor(app) });
    q.run('UPDATE apps SET last_poll_at = ?, last_poll_error = ? WHERE id = ?', now(), sha ? null : `브랜치 ${app.config.branch} 가 없습니다`, app.id);
    if (sha && (sha !== app.last_seen_sha || source === 'webhook')) {
      await onRemoteUpdate(getApp(app.slug), sha, source);
    }
    return sha;
  } catch (e) {
    q.run('UPDATE apps SET last_poll_at = ?, last_poll_error = ? WHERE id = ?', now(), errMsg(e).slice(0, 500), app.id);
    bus.publish('apps', { slug: app.slug });
    throw e;
  } finally {
    inflight.delete(app.id);
  }
}

let ticking = false;

export async function pollTick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = listApps().filter(
      (a) => a.config.pollEnabled && a.deployed_sha && (!a.last_poll_at || now() - a.last_poll_at >= a.config.pollIntervalSec * 1000),
    );
    // 동시에 3개까지
    for (let i = 0; i < due.length; i += 3) {
      await Promise.allSettled(due.slice(i, i + 3).map((a) => checkApp(a)));
    }
  } finally {
    ticking = false;
  }
}
