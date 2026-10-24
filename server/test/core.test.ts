import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inCidr, normalizeIp } from '../http/auth.ts';
import { isDue } from '../services/backups.ts';
import { scopePatterns } from '../services/deploy.ts';
import { matchesAny, normalizeRepoUrl, toPathspec } from '../services/git.ts';
import { parseDotenv, toDotenv } from '../services/apps.ts';
import { envFileLine, execShell } from '../services/systemd.ts';
import { splitArgs, unescapeUtf8 } from '../services/databases/redis.ts';

test('보존 경로 패턴 (gitignore 스타일)', () => {
  assert.equal(toPathspec('*.db'), ':(glob)**/*.db');
  assert.equal(toPathspec('/data/'), ':(glob)data/**');
  assert.equal(toPathspec('# 주석'), null);
  assert.ok(matchesAny('local.db', ['*.db']));
  assert.ok(matchesAny('sub/dir/x.db', ['*.db']));
  assert.ok(matchesAny('data/a/b.json', ['/data/']));
  assert.ok(!matchesAny('src/data/b.json', ['/data/']));
  assert.ok(matchesAny('app.sqlite3-wal', ['*.sqlite3-*']));
  assert.ok(!matchesAny('server.js', ['*.db', '/data/', '.env']));
  assert.ok(matchesAny('.env', ['.env']));
});

test('모노레포 루트 폴더 기준으로 패턴 변환', () => {
  assert.deepEqual(scopePatterns(['/data/', '*.db', 'cfg/x.json'], 'apps/api'), ['/apps/api/data/', '*.db', '/apps/api/cfg/x.json']);
  assert.ok(matchesAny('apps/api/data/x', scopePatterns(['/data/'], 'apps/api')));
  assert.ok(!matchesAny('data/x', scopePatterns(['/data/'], 'apps/api')));
});

test('저장소 주소 정규화', () => {
  assert.equal(normalizeRepoUrl('dariring/HROne', 'none'), 'https://github.com/dariring/HROne.git');
  assert.equal(normalizeRepoUrl('https://github.com/a/b/', 'token'), 'https://github.com/a/b.git');
  assert.equal(normalizeRepoUrl('https://github.com/a/b.git', 'deploykey'), 'git@github.com:a/b.git');
  assert.equal(normalizeRepoUrl('git@github.com:a/b.git', 'none'), 'https://github.com/a/b.git');
  assert.equal(normalizeRepoUrl('http://10.0.0.5:3000/team/app', 'none'), 'http://10.0.0.5:3000/team/app.git');
  assert.throws(() => normalizeRepoUrl('not a url', 'none'));
});

test('설정의 GitHub 토큰은 GitHub 주소에만', async () => {
  const { isGithubUrl } = await import('../services/git.ts');
  for (const u of ['dariring/HROne', 'https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@github.com/a/b.git', 'https://x-access-token@github.com/a/b']) assert.ok(isGithubUrl(u), u);
  for (const u of ['http://127.0.0.1:18080/app.git', 'https://gitea.example.com/a/b.git', 'https://github.com.evil.io/a/b', 'git@gitlab.com:a/b.git', 'https://evil.io/github.com/a']) assert.ok(!isGithubUrl(u), u);
});

test('systemd EnvironmentFile / ExecStart 이스케이프', () => {
  assert.equal(envFileLine('A', 'x "y" $HOME \\ `z`'), 'A="x \\"y\\" \\$HOME \\\\ \\`z\\`"');
  assert.equal(execShell('node -e "console.log(1)" 100%'), '/bin/bash -c "node -e \\"console.log(1)\\" 100%%"');
  assert.equal(execShell('echo $PORT'), '/bin/bash -c "echo $$PORT"');
});

test('.env 파싱', () => {
  const v = parseDotenv('# c\nexport A=1\nB="two words # not comment"\nC=x # comment\nD="l1\nl2"\nE=\'q\'');
  assert.deepEqual(v, [
    { key: 'A', value: '1' },
    { key: 'B', value: 'two words # not comment' },
    { key: 'C', value: 'x' },
    { key: 'D', value: 'l1\nl2' },
    { key: 'E', value: 'q' },
  ]);
  assert.deepEqual(parseDotenv(toDotenv(v)), v);
});

test('IP 허용 범위', () => {
  assert.ok(inCidr('100.101.102.103', '100.64.0.0/10'));
  assert.ok(!inCidr('100.128.0.1', '100.64.0.0/10'));
  assert.ok(inCidr('::ffff:192.168.1.5', '192.168.0.0/16'));
  assert.ok(inCidr('fd7a:115c:a1e0::1', 'fc00::/7'));
  assert.ok(!inCidr('8.8.8.8', '10.0.0.0/8'));
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
});

test('예약 백업 시각', () => {
  const s = { enabled: true, mode: 'daily' as const, time: '04:00', intervalHours: 6, keep: 7 };
  const at = new Date(2026, 9, 23, 4, 30);
  assert.ok(isDue(s, null, at));
  assert.ok(!isDue(s, new Date(2026, 9, 23, 4, 1).getTime(), at));
  assert.ok(isDue(s, new Date(2026, 9, 22, 4, 1).getTime(), at));
  assert.ok(!isDue(s, null, new Date(2026, 9, 23, 3, 59)));
  assert.ok(isDue({ ...s, mode: 'interval' }, at.getTime() - 6 * 3600_000, at));
  assert.ok(!isDue({ ...s, enabled: false }, null, at));
});

test('redis 콘솔 인자 / 한글 복원', () => {
  assert.deepEqual(splitArgs('SET k "a b" \'c d\' ""'), ['SET', 'k', 'a b', 'c d', '']);
  assert.equal(unescapeUtf8('"\\xec\\x95\\x88\\xeb\\x85\\x95"'), '"안녕"');
  assert.equal(unescapeUtf8('\\xff'), '\\xff');
});

test('MariaDB 데이터 보기: 배치 출력 파싱과 SQL', async () => {
  const { browseSql, parseBatch } = await import('../services/databases/mariadb.ts');
  assert.deepEqual(parseBatch('va\\tb\tn\nv줄1\\n줄2\tv\\\\x\n'), [
    ['va\tb', 'n'],
    ['v줄1\n줄2', 'v\\x'],
  ]);
  assert.deepEqual(parseBatch(''), []);
  const cols = [
    { name: 'id', type: 'int', columnType: 'int(11)', key: 'PRI', nullable: false },
    { name: 'na`me', type: 'varchar', columnType: 'varchar(20)', key: '', nullable: true },
  ];
  const q = browseSql('app', 'my t', cols, { page: 2, size: 25, filterCol: 'na`me', filter: "50%_'x" });
  assert.match(q.rows, /FROM `app`\.`my t` WHERE CONVERT\(`na``me` USING utf8mb4\) LIKE '%50\\\\%\\\\_\\'x%' ORDER BY `id` LIMIT 26 OFFSET 50;$/);
  assert.equal(browseSql('app', 't', cols, { page: 0, size: 999 }).size, 50);
  assert.throws(() => browseSql('app', 't', cols, { page: 0, size: 25, order: 'nope' }), /없는 컬럼/);
});

test('MariaDB AppArmor local 규칙: HROne 구역만 바꾸고 다른 줄은 그대로', async () => {
  const { mariadbAppArmorRules, mergeAppArmorLocal } = await import('../services/packages.ts');
  const block = mariadbAppArmorRules('/var/lib/hrone/databases');
  assert.match(block, /^\/var\/lib\/hrone\/databases\/\*\/data\/\*\* rwk,$/m);
  assert.match(block, /^\/var\/lib\/hrone\/databases\/\*\/my\.cnf r,$/m);
  const first = mergeAppArmorLocal('', block);
  assert.equal(first, block);
  assert.equal(mergeAppArmorLocal(first, block), first, '두 번 써도 같다');
  const mine = '# 내 규칙\n/srv/x r,\n';
  const withMine = mergeAppArmorLocal(mine, block);
  assert.ok(withMine.startsWith(mine) && withMine.endsWith(block));
  const moved = mergeAppArmorLocal(withMine, mariadbAppArmorRules('/data/hrone/databases'));
  assert.ok(moved.startsWith(mine));
  assert.ok(moved.includes('/data/hrone/databases/*/data/** rwk,') && !moved.includes('/var/lib/hrone'));
});
