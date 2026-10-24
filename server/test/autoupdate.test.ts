import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// 각 테스트 파일은 따로 실행되므로 여기서 임시 데이터 폴더를 지정해도 다른 테스트에 영향이 없다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrone-au-'));
process.env.HRONE_DATA = tmp;
const { openDb, q, now } = await import('../lib/db.ts');
openDb();
const au = await import('../services/autoupdate.ts');
const { startJob } = await import('../services/jobs.ts');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('자동 업데이트 기본값과 주기 검증', () => {
  assert.deepEqual(au.autoUpdateSettings(), { enabled: true, intervalHours: 6 });
  assert.throws(() => au.setAutoUpdateSettings({ intervalHours: 5 }), /확인 주기/);
  assert.deepEqual(au.setAutoUpdateSettings({ enabled: false, intervalHours: 24 }), { enabled: false, intervalHours: 24 });
  assert.deepEqual(au.autoUpdateSettings(), { enabled: false, intervalHours: 24 });
});

test('배포·백업·작업이 돌고 있으면 업데이트를 미룬다', async () => {
  assert.equal(au.busyReason(), null);

  const r = q.run(`INSERT INTO backups (kind, target_slug, file, size, trigger, status, note, created_at) VALUES ('database', 'db', '/x', 0, 'schedule', 'running', '', ?)`, now());
  assert.match(au.busyReason() ?? '', /백업/);
  q.run(`UPDATE backups SET status = 'done' WHERE id = ?`, r.lastInsertRowid);
  assert.equal(au.busyReason(), null);

  let release!: () => void;
  startJob('test', 'x', 'DB 만들기', () => new Promise<void>((res) => (release = res)));
  assert.match(au.busyReason() ?? '', /DB 만들기/);
  release();
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(au.busyReason(), null);

  await assert.rejects(
    (async () => {
      startJob('test', 'y', '복원', () => new Promise<void>(() => {}));
      await au.startUpdate('테스트');
    })(),
    (e: { status: number; message: string }) => e.status === 409 && /복원/.test(e.message),
  );
});

test('업데이트 뒤 다시 켜지면 완료로 기록하고, 너무 오래 걸리면 실패로 본다', async () => {
  const cur = await au.currentCommit();
  assert.ok(cur.sha, 'git 저장소에서 실행해야 합니다');

  q.run(`DELETE FROM settings WHERE key = 'auto_update_state'`);
  const { setSetting } = await import('../lib/db.ts');
  setSetting('auto_update_state', { ...au.autoUpdateState(), pending: { from: 'oldsha1', to: '', at: Date.now(), by: '자동' } });
  await au.autoUpdateOnBoot();
  const done = au.autoUpdateState();
  assert.equal(done.pending, null);
  assert.equal(done.lastUpdate?.from, 'oldsha1');
  assert.equal(done.lastUpdate?.to, cur.sha);

  // 같은 커밋으로 다시 켜졌다면(업데이트 도중 재시작 등) 기다림을 유지한다
  setSetting('auto_update_state', { ...au.autoUpdateState(), pending: { from: cur.sha, to: '', at: Date.now(), by: '자동' } });
  await au.autoUpdateOnBoot();
  assert.ok(au.autoUpdateState().pending);

  setSetting('auto_update_state', { ...au.autoUpdateState(), pending: { from: cur.sha, to: '', at: Date.now() - 21 * 60_000, by: '자동' } });
  await au.autoUpdateTick();
  const failed = au.autoUpdateState();
  assert.equal(failed.pending, null);
  assert.equal(failed.lastResult, 'error');
});
