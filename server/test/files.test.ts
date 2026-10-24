import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerFileRoutes } from '../http/routes/files.ts';
import { HttpError } from '../lib/util.ts';
import { attachmentHeader, listDir, readPreview, resolveInside } from '../services/files.ts';

let tmp: string;
let root: string;
let server: FastifyInstance;
const downloads: string[] = [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrone-files-'));
  root = path.join(tmp, 'my-app');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'console.log("안녕")\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'x');
  fs.writeFileSync(path.join(root, 'data', 'app.db'), Buffer.from([0x53, 0x51, 0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(root, '한글 메모.txt'), '메모');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'link-out'));
  fs.symlinkSync(tmp, path.join(root, 'dir-out'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link-in'));

  server = Fastify();
  server.setErrorHandler((err, _req, reply) => {
    reply.code(err instanceof HttpError ? err.status : 500).send({ error: (err as Error).message });
  });
  registerFileRoutes(server, '/api/apps/:slug/files', { root: () => root, onDownload: (_req, rel) => downloads.push(rel) });
  registerFileRoutes(server, '/api/apps/:slug/missing', { root: () => path.join(tmp, 'nope') });
  await server.ready();
});

after(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HttpError).status;
  }
  return 200;
};

test('앱 폴더 밖으로 나가는 경로는 막는다', () => {
  assert.equal(status(() => resolveInside(root, '../secret.txt')), 400);
  assert.equal(status(() => resolveInside(root, 'src/../../secret.txt')), 400);
  assert.equal(status(() => resolveInside(root, 'link-out')), 400);
  assert.equal(status(() => resolveInside(root, 'dir-out/secret.txt')), 400);
  // 절대 경로는 앱 폴더 기준으로 해석된다 (/etc/passwd → <앱>/etc/passwd → 없음)
  assert.equal(status(() => resolveInside(root, '/etc/passwd')), 404);
  assert.equal(resolveInside(root, '').rel, '');
  assert.equal(resolveInside(root, 'link-in').rel, 'src');
});

test('폴더 목록: 폴더 먼저, 바깥 링크는 열 수 없는 링크로', () => {
  const r = listDir(root, '');
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.equal(byName['src']!.type, 'dir');
  assert.equal(byName['link-in']!.type, 'dir');
  assert.equal(byName['link-out']!.type, 'link');
  assert.equal(byName['link-out']!.target, null);
  assert.equal(byName['dir-out']!.type, 'link');
  const firstFile = r.entries.findIndex((e) => e.type !== 'dir');
  assert.ok(r.entries.slice(firstFile).every((e) => e.type !== 'dir'));
});

test('미리보기: 텍스트와 바이너리 구분', () => {
  assert.equal(readPreview(root, 'src/index.js').text, 'console.log("안녕")\n');
  const bin = readPreview(root, 'data/app.db');
  assert.equal(bin.binary, true);
  assert.equal(bin.text, null);
  assert.equal(status(() => readPreview(root, 'src')), 400);
});

test('한글 파일명 내려받기 헤더', () => {
  assert.equal(attachmentHeader('한글 메모.txt'), `attachment; filename="__ __.txt"; filename*=UTF-8''%ED%95%9C%EA%B8%80%20%EB%A9%94%EB%AA%A8.txt`);
});

test('API: 목록 / 미리보기 / 파일 내려받기', async () => {
  const list = await server.inject('/api/apps/my-app/files?path=src');
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().entries.map((e: { name: string }) => e.name), ['index.js']);

  const bad = await server.inject('/api/apps/my-app/files/content?path=..%2Fsecret.txt');
  assert.equal(bad.statusCode, 400);

  const file = await server.inject('/api/apps/my-app/files/download?path=data%2Fapp.db');
  assert.equal(file.statusCode, 200);
  assert.deepEqual(file.rawPayload, Buffer.from([0x53, 0x51, 0x00, 0x01, 0x02]));
  assert.match(String(file.headers['content-disposition']), /filename="app\.db"/);

  const missing = await server.inject('/api/apps/x/missing');
  assert.equal(missing.statusCode, 404);
});

test('API: 폴더는 tar.gz 로, 기본은 node_modules 제외', async () => {
  const names = async (q: string) => {
    const r = await server.inject(`/api/apps/my-app/files/download${q}`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/gzip');
    const f = path.join(tmp, `out-${Math.random()}.tar.gz`);
    fs.writeFileSync(f, r.rawPayload);
    return execFileSync('tar', ['-tzf', f], { encoding: 'utf8' }).split('\n').filter(Boolean);
  };
  const plain = await names('');
  assert.ok(plain.some((n) => n.replace(/\/$/, '') === 'my-app/src/index.js'));
  assert.ok(plain.some((n) => n.startsWith('my-app/data/app.db')));
  assert.ok(!plain.some((n) => n.includes('node_modules')));
  const all = await names('?deps=1');
  assert.ok(all.some((n) => n.includes('node_modules/dep/index.js')));
  assert.ok(downloads.includes('/'));
  assert.ok(downloads.includes('data/app.db'));
});

test('웹 UI: index.html 은 캐시하지 않고 assets 는 오래 캐시', async () => {
  const { registerWeb } = await import('../http/web.ts');
  const dist = path.join(tmp, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'x');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
  const web = Fastify();
  await registerWeb(web, dist);
  await web.ready();
  const get = (u: string) => web.inject(u);
  for (const u of ['/', '/apps/my-bot', '/index.html']) {
    const r = await get(u);
    assert.equal(r.statusCode, 200, u);
    assert.equal(r.headers['cache-control'], 'no-cache', u);
    assert.match(r.body, /<title>t<\/title>/);
  }
  assert.equal((await get('/assets/index-abc.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await get('/favicon.svg')).headers['cache-control'], 'public, max-age=3600');
  assert.equal((await get('/api/nope')).statusCode, 404);
  await web.close();
});
