import fs from 'node:fs';
import path from 'node:path';
import { audit, type Actor } from '../lib/audit.ts';
import { decryptJSON, encryptJSON, randomToken } from '../lib/crypto.ts';
import { now, q } from '../lib/db.ts';
import { bus } from '../lib/events.ts';
import { run, tryRun } from '../lib/exec.ts';
import { errMsg, log } from '../lib/log.ts';
import { appDataDir, appDir, appUser, PATHS, UNIT } from '../lib/paths.ts';
import { DEFAULT_NOTIFY, NO_LIMITS, settings } from '../lib/settings.ts';
import type { App, AppConfig, AppRow, AppSecrets, EnvVar } from '../lib/types.ts';
import { assertSlug, clampInt, HttpError, KeyedMutex, rmrf, writeFileIfChanged } from '../lib/util.ts';
import { linkedEnvFor, linkedUnitsFor } from './databases/links.ts';
import type { GitAuth } from './git.ts';
import { isGithubUrl, normalizeRepoUrl } from './git.ts';
import * as journal from './journal.ts';
import { matchInstalledNode } from './runtimes.ts';
import * as systemd from './systemd.ts';
import { ensureUser, identity, deleteUser, type Identity } from './users.ts';

export const appLock = new KeyedMutex();

export const DEFAULT_PRESERVE = [
  '.env',
  '.env.local',
  '.env.production',
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.db-journal',
  '*.sqlite',
  '*.sqlite3',
  '*.sqlite-*',
  '*.sqlite3-*',
  '/data/',
  '/storage/',
  '/uploads/',
  '/logs/',
];

export function defaultConfig(): AppConfig {
  return {
    runtime: 'node',
    runtimeVersion: '24',
    repoUrl: '',
    branch: 'main',
    auth: 'none',
    rootDir: '',
    installCmd: '',
    buildCmd: '',
    startCmd: '',
    releaseCmd: '',
    installAlways: false,
    allowInstallScripts: true,
    port: null,
    publicUrl: '',
    writeDotenv: false,
    deployMode: 'auto',
    deployDelaySec: 60,
    pollEnabled: true,
    pollIntervalSec: settings.defaults().pollIntervalSec,
    watchPaths: [],
    preservePaths: [...DEFAULT_PRESERVE],
    localChanges: 'overwrite',
    autostart: true,
    restartPolicy: 'on-failure',
    healthPath: '',
    healthTimeoutSec: 30,
    autoRollback: true,
    runAsRoot: false,
    forceColor: true,
    resources: { ...NO_LIMITS },
    notify: { ...settings.defaults().notify },
    backup: { enabled: false, mode: 'daily', time: '04:30', intervalHours: 6, keep: 7 },
  };
}

export function toApp(row: AppRow): App {
  const { config, env_enc: _e, secrets_enc: _s, ...rest } = row;
  const base = defaultConfig();
  const parsed = JSON.parse(config) as Partial<AppConfig>;
  return {
    ...rest,
    config: {
      ...base,
      ...parsed,
      resources: { ...NO_LIMITS, ...parsed.resources },
      notify: { ...DEFAULT_NOTIFY, ...parsed.notify },
      backup: { ...base.backup, ...parsed.backup },
    },
  };
}

export function getAppRow(slug: string): AppRow {
  const row = q.get<AppRow>('SELECT * FROM apps WHERE slug = ?', slug);
  if (!row) throw new HttpError(404, `앱을 찾을 수 없습니다: ${slug}`);
  return row;
}

export const getApp = (slug: string) => toApp(getAppRow(slug));
export const getAppById = (id: number) => {
  const row = q.get<AppRow>('SELECT * FROM apps WHERE id = ?', id);
  return row ? toApp(row) : null;
};
export const listApps = () => q.all<AppRow>('SELECT * FROM apps ORDER BY name COLLATE NOCASE').map(toApp);

export function getSecrets(slug: string): AppSecrets {
  const row = getAppRow(slug);
  return decryptJSON<AppSecrets>(row.secrets_enc, { webhookSecret: '', discordWebhook: '', gitToken: '' });
}

export function setSecrets(slug: string, s: AppSecrets) {
  q.run('UPDATE apps SET secrets_enc = ?, updated_at = ? WHERE slug = ?', encryptJSON(s), now(), slug);
}

export function getEnv(slug: string): EnvVar[] {
  return decryptJSON<EnvVar[]>(getAppRow(slug).env_enc, []);
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(['PATH', 'HOME', 'USER']);

export function setEnv(slug: string, vars: EnvVar[]) {
  const seen = new Set<string>();
  const clean: EnvVar[] = [];
  for (const v of vars) {
    const key = String(v.key ?? '').trim();
    if (!key) continue;
    if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `환경변수 이름이 올바르지 않습니다: ${key}`);
    if (RESERVED_ENV.has(key)) throw new HttpError(400, `${key} 는 패널이 관리하는 변수입니다`);
    if (seen.has(key)) throw new HttpError(400, `중복된 환경변수: ${key}`);
    if (String(v.value).includes('\0')) throw new HttpError(400, `${key} 값에 NUL 문자가 있습니다`);
    seen.add(key);
    clean.push({ key, value: String(v.value ?? '') });
  }
  q.run('UPDATE apps SET env_enc = ?, updated_at = ? WHERE slug = ?', encryptJSON(clean), now(), slug);
}

/** .env 텍스트 파싱 (KEY=VALUE, 따옴표, export, 주석) */
export function parseDotenv(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // 여러 줄 값 지원
      let body = value.slice(1);
      while (!body.endsWith(quote) && i + 1 < lines.length) body += '\n' + lines[++i];
      value = body.endsWith(quote) ? body.slice(0, -1) : body;
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out.push({ key, value });
  }
  return out;
}

export function toDotenv(vars: EnvVar[]) {
  return vars
    .map(({ key, value }) =>
      /^[\w@%+=:,./-]*$/.test(value) ? `${key}=${value}` : `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join('\n');
}

// ---------- 검증 ----------

function str(v: unknown, max = 500) {
  return String(v ?? '').trim().slice(0, max);
}

function normPaths(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : String(v ?? '').split('\n');
  return arr.map((s) => String(s).trim()).filter((s) => s && !s.startsWith('#')).slice(0, 100);
}

export function normalizeConfig(input: Partial<AppConfig>, base: AppConfig): AppConfig {
  const c: AppConfig = { ...base, ...input } as AppConfig;
  if (c.runtime !== 'node' && c.runtime !== 'python') throw new HttpError(400, '런타임은 node 또는 python 이어야 합니다');
  c.runtimeVersion = str(c.runtimeVersion, 20) || (c.runtime === 'node' ? '24' : 'system');
  if (c.runtime === 'node' && !/^(lts|v?\d+(\.\d+){0,2})$/.test(c.runtimeVersion)) throw new HttpError(400, 'Node 버전 형식 오류 (예: 24, 22.11.0)');
  if (c.runtime === 'python' && !/^(system|\d+\.\d+(\.\d+)?)$/.test(c.runtimeVersion)) throw new HttpError(400, 'Python 버전 형식 오류 (예: system, 3.12)');
  if (!['none', 'token', 'deploykey'].includes(c.auth)) c.auth = 'none';
  c.repoUrl = normalizeRepoUrl(str(c.repoUrl), c.auth);
  c.branch = str(c.branch, 200) || 'main';
  if (!/^[\w./-]+$/.test(c.branch) || c.branch.includes('..')) throw new HttpError(400, '브랜치 이름이 올바르지 않습니다');
  c.rootDir = str(c.rootDir, 200).replace(/^\/+|\/+$/g, '');
  if (c.rootDir.split('/').some((p) => p === '..')) throw new HttpError(400, '루트 폴더에 .. 을 쓸 수 없습니다');
  c.installCmd = str(c.installCmd, 2000);
  c.buildCmd = str(c.buildCmd, 2000);
  c.startCmd = str(c.startCmd, 2000);
  c.releaseCmd = str(c.releaseCmd, 2000);
  c.installAlways = !!c.installAlways;
  c.allowInstallScripts = c.allowInstallScripts !== false;
  c.port = c.port === null || c.port === undefined || (c.port as unknown) === '' ? null : clampInt(c.port, 1024, 65535, 3000);
  c.publicUrl = str(c.publicUrl, 300);
  c.writeDotenv = !!c.writeDotenv;
  if (!['auto', 'delay', 'manual'].includes(c.deployMode)) c.deployMode = 'auto';
  c.deployDelaySec = clampInt(c.deployDelaySec, 1, 7 * 86400, 60);
  c.pollEnabled = !!c.pollEnabled;
  c.pollIntervalSec = clampInt(c.pollIntervalSec, 15, 86400, 60);
  c.watchPaths = normPaths(c.watchPaths);
  c.preservePaths = normPaths(c.preservePaths);
  if (c.localChanges !== 'keep') c.localChanges = 'overwrite';
  c.autostart = !!c.autostart;
  if (!['always', 'on-failure', 'no'].includes(c.restartPolicy)) c.restartPolicy = 'on-failure';
  c.healthPath = str(c.healthPath, 300);
  if (c.healthPath && !c.healthPath.startsWith('/')) c.healthPath = '/' + c.healthPath;
  c.healthTimeoutSec = clampInt(c.healthTimeoutSec, 3, 600, 30);
  c.autoRollback = !!c.autoRollback;
  c.runAsRoot = !!c.runAsRoot;
  c.forceColor = !!c.forceColor;
  c.resources = normalizeResources(c.resources);
  c.notify = { ...DEFAULT_NOTIFY, ...c.notify };
  const b = { ...base.backup, ...c.backup };
  c.backup = {
    enabled: !!b.enabled,
    mode: b.mode === 'interval' ? 'interval' : 'daily',
    time: /^\d{2}:\d{2}$/.test(b.time) ? b.time : '04:30',
    intervalHours: clampInt(b.intervalHours, 1, 168, 6),
    keep: clampInt(b.keep, 1, 365, 7),
  };
  return c;
}

export function normalizeResources(r: unknown) {
  const o = (r ?? {}) as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number) => {
    if (v === null || v === undefined || v === '' || Number(v) <= 0) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  return {
    cpu: num(o.cpu, 0.05, 1024),
    memoryMB: num(o.memoryMB, 32, 4 * 1024 * 1024),
    swapMB: o.swapMB === 0 || o.swapMB === '0' ? 0 : num(o.swapMB, 0, 4 * 1024 * 1024),
    tasks: num(o.tasks, 8, 1_000_000),
    cpuWeight: num(o.cpuWeight, 1, 10000),
  };
}

// ---------- 포트 ----------

export async function listeningPorts(): Promise<Set<number>> {
  const r = await tryRun('ss', ['-Htln']);
  const set = new Set<number>();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/\S+:(\d+)\s+\S+\s*$/);
    if (m) set.add(Number(m[1]));
  }
  return set;
}

export function usedPorts(exceptAppId?: number): Map<number, string> {
  const used = new Map<number, string>();
  used.set(settings.panel().port, 'HROne 패널');
  for (const a of listApps()) if (a.config.port && a.id !== exceptAppId) used.set(a.config.port, `앱 ${a.name}`);
  for (const d of q.all<{ name: string; config: string }>('SELECT name, config FROM databases')) {
    const port = (JSON.parse(d.config) as { port?: number }).port;
    if (port) used.set(port, `DB ${d.name}`);
  }
  return used;
}

export async function allocatePort(from = 3000, to = 3999) {
  const used = usedPorts();
  const listening = await listeningPorts();
  for (let p = from; p <= to; p++) if (!used.has(p) && !listening.has(p)) return p;
  throw new HttpError(409, '사용 가능한 포트가 없습니다');
}

// ---------- 런타임 환경 ----------

export function workDir(app: App) {
  return path.join(appDir(app.slug), app.config.rootDir);
}

export const venvDir = (slug: string) => path.join(appDataDir(slug), 'venv');
export const homeDir = (slug: string) => path.join(appDataDir(slug), 'home');
export const keyPath = (slug: string) => path.join(appDataDir(slug), 'deploy_key');
const runtimeEnvPath = (slug: string) => path.join(appDataDir(slug), 'runtime.env');

export function appIdentity(app: App): Identity {
  return app.config.runAsRoot ? { user: 'root', uid: 0, gid: 0, home: homeDir(app.slug) } : identity(appUser(app.slug), homeDir(app.slug));
}

export async function ensureAppIdentity(app: App): Promise<Identity> {
  fs.mkdirSync(appDataDir(app.slug), { recursive: true, mode: 0o711 });
  fs.chmodSync(appDataDir(app.slug), 0o711);
  if (app.config.runAsRoot) {
    fs.mkdirSync(homeDir(app.slug), { recursive: true });
    return { user: 'root', uid: 0, gid: 0, home: homeDir(app.slug) };
  }
  const id = await ensureUser(appUser(app.slug), homeDir(app.slug));
  if (id.created) {
    // 재설치 등으로 계정이 새로 만들어졌으면 기존 파일 소유자를 맞춘다
    const dirs = [appDir(app.slug), homeDir(app.slug), venvDir(app.slug)].filter((p) => fs.existsSync(p));
    if (dirs.length) await run('chown', ['-R', `${id.uid}:${id.gid}`, ...dirs]);
    for (const f of [keyPath(app.slug), keyPath(app.slug) + '.pub']) if (fs.existsSync(f)) fs.chownSync(f, id.uid, id.gid);
  }
  return id;
}

export function gitAuthFor(app: App): GitAuth {
  if (app.config.auth === 'token') {
    // 설정의 GitHub 토큰은 github.com 저장소에만 쓴다
    const token = getSecrets(app.slug).gitToken || (isGithubUrl(app.config.repoUrl) ? settings.githubToken() : '');
    return { type: 'token', token };
  }
  if (app.config.auth === 'deploykey') return { type: 'deploykey', keyPath: keyPath(app.slug) };
  return { type: 'none' };
}

/** 앱 실행 시 PATH 에 넣을 bin 디렉터리 (venv, node) */
export function runtimeBinDirs(app: App): string[] {
  const dirs: string[] = [];
  if (app.config.runtime === 'python') dirs.push(path.join(venvDir(app.slug), 'bin'));
  // 파이썬 앱도 빌드 도구로 node 를 쓸 수 있게 기본 node 를 뒤에 둔다
  const nodeVer = app.config.runtime === 'node' ? matchInstalledNode(app.config.runtimeVersion) : matchInstalledNode('lts');
  if (nodeVer) dirs.push(path.join(PATHS.nodeRuntimes, nodeVer, 'bin'));
  dirs.push(PATHS.bin);
  return dirs;
}

/** 패널이 주입하는 기본 변수 + DB 연결 변수 + 사용자 변수 (뒤가 우선) */
export function buildEnv(app: App, opts: { forBuild?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [...runtimeBinDirs(app), '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'].join(':'),
    HOME: homeDir(app.slug),
    LANG: 'C.UTF-8',
    HOST: '127.0.0.1',
    HRONE_APP: app.slug,
  };
  if (app.config.port) env.PORT = String(app.config.port);
  if (app.config.runtime === 'node') {
    env.NODE_ENV = 'production';
    env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
    env.npm_config_update_notifier = 'false';
    env.npm_config_fund = 'false';
  } else {
    env.PYTHONUNBUFFERED = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.VIRTUAL_ENV = venvDir(app.slug);
    env.UV_PROJECT_ENVIRONMENT = venvDir(app.slug);
    env.UV_PYTHON_INSTALL_DIR = PATHS.pythonRuntimes;
    env.UV_LINK_MODE = 'copy';
  }
  if (app.config.forceColor) env.FORCE_COLOR = '1';
  for (const v of linkedEnvFor(app.id)) env[v.key] = v.value;
  for (const v of getEnv(app.slug)) env[v.key] = v.value;
  if (opts.forBuild) {
    env.CI = env.CI ?? '1';
    if (app.config.allowInstallScripts) {
      // npm 11 의 allowScripts / pnpm 10 의 onlyBuiltDependencies 기본 차단을 끈다 (앱 전용 계정으로 실행됨)
      env.npm_config_dangerously_allow_all_scripts = env.npm_config_dangerously_allow_all_scripts ?? 'true';
      // pnpm 전용 설정이라 npm 에 넘기면 "Unknown env config" 경고가 나온다
      if (fs.existsSync(path.join(workDir(app), 'pnpm-lock.yaml'))) {
        env.npm_config_dangerously_allow_all_builds = env.npm_config_dangerously_allow_all_builds ?? 'true';
      }
    }
  }
  return env;
}

export function unitContent(app: App): string {
  const id = app.config.runAsRoot ? null : appUser(app.slug);
  const dbUnits = linkedUnitsFor(app.id);
  const after = ['network-online.target', ...dbUnits].join(' ');
  const lines = [
    '# HROne 이 관리하는 파일입니다. 직접 수정하지 마세요 (패널에서 덮어씁니다).',
    '[Unit]',
    `Description=HROne 앱 ${app.name}`,
    `After=${after}`,
    `Wants=${after}`,
    'StartLimitIntervalSec=120',
    'StartLimitBurst=8',
    '',
    '[Service]',
    'Type=simple',
    ...(id ? [`User=${id}`, `Group=${id}`] : []),
    `WorkingDirectory=${workDir(app)}`,
    `EnvironmentFile=${runtimeEnvPath(app.slug)}`,
    `ExecStart=${systemd.execShell(app.config.startCmd || 'echo "시작 명령이 설정되지 않았습니다" >&2; exit 1')}`,
    `Restart=${app.config.restartPolicy}`,
    'RestartSec=3',
    'TimeoutStopSec=20',
    'KillMode=control-group',
    'LimitNOFILE=1048576',
    ...(id ? ['NoNewPrivileges=yes'] : []),
    'StandardOutput=journal',
    'StandardError=journal',
    `SyslogIdentifier=${app.slug}`,
    'LogRateLimitIntervalSec=10s',
    'LogRateLimitBurst=50000',
    `Slice=${UNIT.appsSlice}`,
    'CPUAccounting=yes',
    'MemoryAccounting=yes',
    'TasksAccounting=yes',
    ...systemd.resourceDirectives(app.config.resources),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ];
  return lines.join('\n');
}

/** env 파일과 유닛 파일을 쓴다. 유닛이 바뀌면 daemon-reload */
export async function writeRuntime(app: App) {
  const env = buildEnv(app);
  const envText = Object.entries(env)
    .map(([k, v]) => systemd.envFileLine(k, v))
    .join('\n');
  writeFileIfChanged(runtimeEnvPath(app.slug), envText + '\n', 0o600);
  if (app.config.writeDotenv && fs.existsSync(workDir(app))) {
    const id = appIdentity(app);
    const file = path.join(workDir(app), '.env');
    const user = getEnv(app.slug).concat(linkedEnvFor(app.id));
    const userMap = new Map(user.map((v) => [v.key, v.value]));
    if (app.config.port) userMap.set('PORT', String(app.config.port));
    const text = `# HROne 이 배포마다 다시 씁니다. 값은 패널의 환경변수 탭에서 바꾸세요.\n${toDotenv([...userMap].map(([key, value]) => ({ key, value })))}\n`;
    if (writeFileIfChanged(file, text, 0o600)) fs.chownSync(file, id.uid, id.gid);
  }
  const changed = systemd.writeUnit(UNIT.app(app.slug), unitContent(app));
  if (changed) await systemd.daemonReload();
  const enabled = await systemd.isEnabled(UNIT.app(app.slug));
  if (enabled !== app.config.autostart) await systemd.setEnabled(UNIT.app(app.slug), app.config.autostart);
  return changed;
}

// ---------- 생성 / 수정 ----------

export interface CreateAppInput {
  slug: string;
  name: string;
  config: Partial<AppConfig>;
  env?: EnvVar[];
  gitToken?: string;
  discordWebhook?: string;
}

export async function createApp(input: CreateAppInput, actor: Actor): Promise<App> {
  const slug = str(input.slug, 30).toLowerCase();
  assertSlug(slug);
  if (q.get('SELECT 1 FROM apps WHERE slug = ?', slug)) throw new HttpError(409, `이미 있는 앱 ID 입니다: ${slug}`);
  const name = str(input.name, 80) || slug;
  const cfg = normalizeConfig(input.config, defaultConfig());
  if (!cfg.port) cfg.port = await allocatePort();
  const conflict = usedPorts().get(cfg.port);
  if (conflict) throw new HttpError(409, `포트 ${cfg.port} 는 ${conflict} 가 사용 중입니다`);
  const secrets: AppSecrets = {
    webhookSecret: randomToken(24),
    discordWebhook: str(input.discordWebhook, 500),
    gitToken: str(input.gitToken, 500),
  };
  const t = now();
  q.run(
    `INSERT INTO apps (slug, name, config, env_enc, secrets_enc, desired_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    slug,
    name,
    JSON.stringify(cfg),
    encryptJSON([]),
    encryptJSON(secrets),
    t,
    t,
  );
  if (input.env?.length) setEnv(slug, input.env);
  const app = getApp(slug);
  try {
    const id = await ensureAppIdentity(app);
    fs.mkdirSync(appDir(slug), { recursive: true });
    fs.chownSync(appDir(slug), id.uid, id.gid);
    if (cfg.auth === 'deploykey') await generateDeployKey(app);
  } catch (e) {
    q.run('DELETE FROM apps WHERE slug = ?', slug);
    throw e;
  }
  audit(actor, 'app.create', slug, { repo: cfg.repoUrl, branch: cfg.branch });
  bus.publish('apps', { slug });
  return app;
}

export async function generateDeployKey(app: App) {
  const id = await ensureAppIdentity(app);
  const kp = keyPath(app.slug);
  fs.rmSync(kp, { force: true });
  fs.rmSync(kp + '.pub', { force: true });
  await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `hrone-${app.slug}`, '-f', kp, '-q']);
  fs.chownSync(kp, id.uid, id.gid);
  fs.chownSync(kp + '.pub', id.uid, id.gid);
  fs.chmodSync(kp, 0o600);
  return fs.readFileSync(kp + '.pub', 'utf8').trim();
}

export function deployKeyPub(slug: string) {
  try {
    return fs.readFileSync(keyPath(slug) + '.pub', 'utf8').trim();
  } catch {
    return '';
  }
}

export interface UpdateResult {
  app: App;
  /** 저장소/브랜치/명령이 바뀌어 다시 배포해야 함 */
  redeploy: boolean;
}

export async function updateApp(slug: string, patch: { name?: string; config?: Partial<AppConfig> }, actor: Actor): Promise<UpdateResult> {
  return appLock.run(slug, async () => {
    const app = getApp(slug);
    const cfg = normalizeConfig(patch.config ?? {}, app.config);
    if (cfg.port && cfg.port !== app.config.port) {
      const conflict = usedPorts(app.id).get(cfg.port);
      if (conflict) throw new HttpError(409, `포트 ${cfg.port} 는 ${conflict} 가 사용 중입니다`);
    }
    if (!cfg.port) cfg.port = app.config.port;
    const name = patch.name !== undefined ? str(patch.name, 80) || app.name : app.name;
    const redeployKeys: (keyof AppConfig)[] = ['repoUrl', 'branch', 'rootDir', 'installCmd', 'buildCmd', 'runtime', 'runtimeVersion', 'auth'];
    const redeploy = !!app.deployed_sha && redeployKeys.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(app.config[k]));
    q.run('UPDATE apps SET name = ?, config = ?, updated_at = ? WHERE slug = ?', name, JSON.stringify(cfg), now(), slug);
    const next = getApp(slug);
    if (cfg.auth === 'deploykey' && !fs.existsSync(keyPath(slug))) await generateDeployKey(next);
    if (cfg.runAsRoot !== app.config.runAsRoot) {
      const id = await ensureAppIdentity(next);
      const dirs = [appDir(slug), homeDir(slug), venvDir(slug)].filter((p) => fs.existsSync(p));
      if (dirs.length) await run('chown', ['-R', `${id.uid}:${id.gid}`, ...dirs]);
    }
    if (next.deployed_sha) await writeRuntime(next);
    if (JSON.stringify(cfg.resources) !== JSON.stringify(app.config.resources)) {
      await systemd.applyResourcesLive(UNIT.app(slug), cfg.resources);
    }
    audit(actor, 'app.update', slug, diffKeys(app.config, cfg));
    bus.publish('apps', { slug });
    return { app: next, redeploy };
  });
}

function diffKeys(a: AppConfig, b: AppConfig) {
  return (Object.keys(b) as (keyof AppConfig)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

// ---------- 실행 제어 ----------

export type Action = 'start' | 'stop' | 'restart' | 'kill';

export async function lifecycle(slug: string, action: Action, actor: Actor) {
  return appLock.run(`life:${slug}`, async () => {
    const app = getApp(slug);
    const unit = UNIT.app(slug);
    if ((action === 'start' || action === 'restart') && !app.deployed_sha) {
      throw new HttpError(409, '아직 배포되지 않은 앱입니다. 먼저 배포하세요.');
    }
    const who = actor.username;
    switch (action) {
      case 'start':
        await writeRuntime(app);
        await tryRun('systemctl', ['reset-failed', unit]);
        await journal.mark(unit, `▶ 시작 요청 (${who})`);
        await systemd.systemctl('start', '--no-block', unit);
        setDesired(slug, 'running');
        break;
      case 'restart':
        await writeRuntime(app);
        await tryRun('systemctl', ['reset-failed', unit]);
        await journal.mark(unit, `↻ 재시작 요청 (${who})`);
        await systemd.systemctl('restart', '--no-block', unit);
        setDesired(slug, 'running');
        break;
      case 'stop':
        setDesired(slug, 'stopped');
        await journal.mark(unit, `■ 정지 요청 (${who})`);
        await systemd.systemctl('stop', unit);
        break;
      case 'kill':
        setDesired(slug, 'stopped');
        await journal.mark(unit, `✖ 강제 종료 (SIGKILL, ${who})`, 4);
        await tryRun('systemctl', ['kill', '--signal=SIGKILL', unit]);
        await tryRun('systemctl', ['stop', unit]);
        break;
    }
    audit(actor, `app.${action}`, slug);
    bus.publish('apps', { slug });
  });
}

export function setDesired(slug: string, state: 'running' | 'stopped') {
  q.run('UPDATE apps SET desired_state = ?, updated_at = ? WHERE slug = ?', state, now(), slug);
}

export async function setAutostart(slug: string, enabled: boolean, actor: Actor) {
  const app = getApp(slug);
  app.config.autostart = enabled;
  q.run('UPDATE apps SET config = ?, updated_at = ? WHERE slug = ?', JSON.stringify(app.config), now(), slug);
  if (fs.existsSync(systemd.unitPath(UNIT.app(slug)))) await systemd.setEnabled(UNIT.app(slug), enabled);
  audit(actor, 'app.autostart', slug, { enabled });
  bus.publish('apps', { slug });
}

// ---------- 삭제 ----------

export async function terminateApp(slug: string, opts: { backup: boolean }, actor: Actor, makeBackup: (app: App) => Promise<string | null>) {
  return appLock.run(slug, async () => {
    const app = getApp(slug);
    let backupFile: string | null = null;
    if (opts.backup) {
      try {
        backupFile = await makeBackup(app);
      } catch (e) {
        throw new HttpError(500, `최종 백업에 실패해 삭제를 중단했습니다: ${errMsg(e)}`);
      }
    }
    await journal.mark(UNIT.app(slug), `앱 삭제 (${actor.username})`, 4);
    await systemd.removeUnit(UNIT.app(slug));
    rmrf(appDir(slug));
    rmrf(appDataDir(slug));
    for (const d of q.all<{ id: number }>('SELECT id FROM deploys WHERE app_id = ?', app.id)) {
      fs.rmSync(path.join(PATHS.deployLogs, `${d.id}.log`), { force: true });
    }
    rmrf(path.join(PATHS.backups, 'apps', slug, 'deploys'));
    if (!app.config.runAsRoot) await deleteUser(appUser(slug));
    q.run('DELETE FROM apps WHERE id = ?', app.id);
    audit(actor, 'app.terminate', slug, { backup: backupFile });
    log.info(`app ${slug} terminated by ${actor.username}`);
    bus.publish('apps', { slug, deleted: true });
    return { backupFile };
  });
}
