import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import * as appgit from '../services/appgit.ts';
import { createFile, readPreview, writeText } from '../services/files.ts';

let tmp: string;
let origin: string;
let work: string;
let repo: appgit.RepoCtx;

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const status = (e: unknown) => (e as { status?: number }).status;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrone-git-'));
  origin = path.join(tmp, 'origin.git');
  sh(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  const seed = path.join(tmp, 'seed');
  sh(tmp, 'clone', '--quiet', origin, seed);
  fs.mkdirSync(path.join(seed, 'src'));
  fs.writeFileSync(path.join(seed, 'src', 'a.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'data/\n');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '--quiet', '-m', 'init');
  sh(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  // 배포가 만드는 것과 같은 상태: 원격 브랜치 이름의 로컬 브랜치
  work = path.join(tmp, 'app');
  sh(tmp, 'clone', '--quiet', origin, work);
  sh(work, 'checkout', '--quiet', '-f', '-B', 'main', 'origin/main');
  const id = { user: os.userInfo().username, uid: process.getuid!(), gid: process.getgid!(), home: tmp };
  repo = { dir: work, branch: 'main', url: `file://${origin}`, ctx: { id, auth: { type: 'token', token: 'test' } } };
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('웹에서 고친 파일 저장: 소유자·권한 유지, 그사이 바뀌었으면 거절', () => {
  const file = path.join(work, 'src', 'a.js');
  fs.chmodSync(file, 0o640);
  const opened = readPreview(work, 'src/a.js');
  const r = writeText(work, 'src/a.js', 'console.log(2)\n', { mtime: opened.mtime });
  assert.equal(fs.readFileSync(file, 'utf8'), 'console.log(2)\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.ok(!fs.readdirSync(path.join(work, 'src')).some((n) => n.includes('hrone-')), '임시 파일이 남지 않는다');
  assert.throws(() => writeText(work, 'src/a.js', 'x', { mtime: opened.mtime - 5000 }), (e) => status(e) === 409);
  assert.throws(() => writeText(work, '../origin.git/config', 'x', {}), (e) => status(e) === 400);
  assert.ok(r.mtime >= opened.mtime);

  const owner = { uid: process.getuid!(), gid: process.getgid!() };
  assert.equal(createFile(work, 'src', 'b.js', owner).path, 'src/b.js');
  assert.throws(() => createFile(work, 'src', 'b.js', owner), (e) => status(e) === 409);
  assert.throws(() => createFile(work, '', '../x', owner), (e) => status(e) === 400);
  fs.mkdirSync(path.join(work, 'data'));
  fs.writeFileSync(path.join(work, 'data', 'app.db'), 'db');
});

test('바뀐 파일 중 고른 것만 커밋하고 올린다', async () => {
  const s1 = await appgit.status(repo);
  assert.deepEqual(
    s1.files.map((f) => `${f.code}|${f.path}|${f.kind}`).sort(),
    [' M|src/a.js|modified', '??|src/b.js|untracked'],
    'gitignore 된 data/ 는 목록에 없다',
  );
  assert.equal(s1.ahead, 0);

  await assert.rejects(appgit.commit(repo, ['src/zzz.js'], 'x', 'admin'), (e) => status(e) === 400);
  await assert.rejects(appgit.commit(repo, ['src/a.js'], '  ', 'admin'), (e) => status(e) === 400);

  await appgit.commit(repo, ['src/a.js'], '웹에서 수정', 'admin');
  const s2 = await appgit.status(repo);
  assert.deepEqual(s2.files.map((f) => f.path), ['src/b.js'], '고르지 않은 파일은 그대로 남는다');
  assert.equal(s2.ahead, 1);
  assert.equal(s2.unpushed[0]!.message, '웹에서 수정');
  assert.equal(sh(work, 'log', '-1', '--format=%an'), 'admin (HROne)');

  await assert.rejects(appgit.push({ ...repo, ctx: { ...repo.ctx, auth: { type: 'none' } } }), (e) => status(e) === 400);
  const sha = await appgit.push(repo);
  assert.equal(sh(origin, 'rev-parse', 'main'), sha, 'GitHub(원격) 의 main 이 올린 커밋');
  assert.equal((await appgit.status(repo)).ahead, 0);
});

test('GitHub 에 여기 없는 커밋이 있으면 덮어쓰지 않는다', async () => {
  const other = path.join(tmp, 'other');
  sh(tmp, 'clone', '--quiet', origin, other);
  fs.writeFileSync(path.join(other, 'src', 'a.js'), 'console.log("other")\n');
  sh(other, 'commit', '--quiet', '-am', '다른 곳에서 푸시');
  sh(other, 'push', '--quiet', 'origin', 'HEAD:main');
  const remoteBefore = sh(origin, 'rev-parse', 'main');

  await appgit.commit(repo, ['src/b.js'], 'b 추가', 'admin');
  await assert.rejects(appgit.push(repo), (e) => status(e) === 409 && /새 커밋/.test((e as Error).message));
  assert.equal(sh(origin, 'rev-parse', 'main'), remoteBefore, '원격은 그대로');
});

test('git status 파싱 (이름 바꾸기 포함)', () => {
  assert.deepEqual(appgit.parseStatus('R  new.js\0old.js\0 M a b.txt\0?? 새 파일.md\0'), [
    { path: 'new.js', code: 'R ', kind: 'renamed' },
    { path: 'a b.txt', code: ' M', kind: 'modified' },
    { path: '새 파일.md', code: '??', kind: 'untracked' },
  ]);
});

test('배포가 원격 커밋으로 바꾸기 전에, 올리지 못한 커밋은 브랜치로 남긴다', async () => {
  // 앞 테스트에서 올리지 못한 "b 추가" 커밋이 남아 있다
  const head = sh(work, 'rev-parse', 'HEAD');
  sh(work, 'fetch', '--quiet', origin, '+refs/heads/main:refs/remotes/origin/main');
  const target = sh(work, 'rev-parse', 'refs/remotes/origin/main');
  const kept = await appgit.keepUnpushed(work, head, target, repo.ctx, '7');
  assert.equal(kept?.ref, 'hrone/unpushed-7');
  assert.deepEqual(kept?.files, ['src/b.js']);
  assert.equal(sh(work, 'rev-parse', 'hrone/unpushed-7'), head);
  // 배포처럼 원격 커밋으로 바꿔도 커밋은 브랜치에 남아 있다
  sh(work, 'checkout', '--quiet', '-f', '-B', 'main', target);
  assert.ok(!fs.existsSync(path.join(work, 'src', 'b.js')));
  assert.equal(sh(work, 'show', 'hrone/unpushed-7:src/b.js'), '');
  // 이미 원격에 다 있는 상태면 아무것도 하지 않는다
  assert.equal(await appgit.keepUnpushed(work, target, target, repo.ctx, '8'), null);
  const older = sh(work, 'rev-parse', `${target}~1`);
  assert.equal(await appgit.keepUnpushed(work, older, target, repo.ctx, '9'), null);
});
