export type Runtime = 'node' | 'python';
export type DeployMode = 'auto' | 'delay' | 'manual';
export type DesiredState = 'running' | 'stopped';

export interface Resources {
  /** 코어 수 (1.5 = CPUQuota 150%). null = 제한 없음 */
  cpu: number | null;
  memoryMB: number | null;
  swapMB: number | null;
  tasks: number | null;
  /** 1~10000, 기본 100 */
  cpuWeight: number | null;
}

export interface NotifyPrefs {
  push: boolean;
  pending: boolean;
  start: boolean;
  success: boolean;
  failure: boolean;
  crash: boolean;
}

export interface AppConfig {
  runtime: Runtime;
  /** node: '24' / '22.11.0' ; python: 'system' / '3.12' */
  runtimeVersion: string;
  repoUrl: string;
  branch: string;
  auth: 'none' | 'token' | 'deploykey';
  rootDir: string;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  /** 빌드 뒤, 재시작 전에 실행 (마이그레이션 등) */
  releaseCmd: string;
  installAlways: boolean;
  /** npm 11 / pnpm 10 은 의존성 설치 스크립트를 기본으로 막는다. true 면 예전처럼 실행 (sharp, bcrypt 등 네이티브 모듈) */
  allowInstallScripts: boolean;
  port: number | null;
  publicUrl: string;
  writeDotenv: boolean;
  deployMode: DeployMode;
  deployDelaySec: number;
  pollEnabled: boolean;
  pollIntervalSec: number;
  watchPaths: string[];
  preservePaths: string[];
  localChanges: 'overwrite' | 'keep';
  autostart: boolean;
  restartPolicy: 'always' | 'on-failure' | 'no';
  healthPath: string;
  healthTimeoutSec: number;
  autoRollback: boolean;
  runAsRoot: boolean;
  forceColor: boolean;
  resources: Resources;
  notify: NotifyPrefs;
  /** 보존 경로(데이터) 예약 백업 */
  backup: BackupSchedule;
}

export interface AppSecrets {
  webhookSecret: string;
  discordWebhook: string;
  /** 앱 전용 GitHub 토큰 (비우면 전역 토큰) */
  gitToken: string;
}

export interface EnvVar {
  key: string;
  value: string;
}

export interface AppRow {
  id: number;
  slug: string;
  name: string;
  config: string;
  env_enc: string;
  secrets_enc: string;
  desired_state: DesiredState;
  deployed_sha: string | null;
  deployed_at: number | null;
  last_seen_sha: string | null;
  rejected_sha: string | null;
  deps_hash: string | null;
  last_poll_at: number | null;
  last_poll_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface App extends Omit<AppRow, 'config' | 'env_enc' | 'secrets_enc'> {
  config: AppConfig;
}

export type DeployStatus =
  | 'pending'
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'rolled_back'
  | 'rejected'
  | 'cancelled'
  | 'superseded';

export type DeployTrigger = 'push' | 'webhook' | 'manual' | 'rollback' | 'initial' | 'config';

export interface Commit {
  sha: string;
  author: string;
  date: number;
  message: string;
}

export interface DeployRow {
  id: number;
  app_id: number;
  trigger: DeployTrigger;
  status: DeployStatus;
  from_sha: string | null;
  to_sha: string | null;
  commits: string;
  scheduled_at: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  triggered_by: string | null;
  approved_by: string | null;
  error: string | null;
}

export type DbType = 'mariadb' | 'redis';

export interface MariaLimits {
  maxConnections: number;
  maxUserConnections: number;
  maxConnectErrors: number;
  waitTimeout: number;
  maxAllowedPacketMB: number;
  innodbBufferPoolMB: number;
  tableOpenCache: number;
  threadCacheSize: number;
}

export interface RedisLimits {
  maxClients: number;
  maxMemoryMB: number;
  maxMemoryPolicy: string;
  timeout: number;
  appendonly: boolean;
  save: string;
}

export interface BackupSchedule {
  enabled: boolean;
  mode: 'daily' | 'interval';
  /** HH:MM (서버 시간대) */
  time: string;
  intervalHours: number;
  keep: number;
}

export interface DbConfig {
  port: number;
  /** 'local' = 127.0.0.1, 'all' = 0.0.0.0, 그 외 = 특정 IP */
  bind: string;
  autostart: boolean;
  resources: Resources;
  limits: MariaLimits | RedisLimits;
  backup: BackupSchedule;
  defaultDb: string;
  appUser: string;
  adminUser: string;
}

export interface DbSecrets {
  adminPassword: string;
  appPassword: string;
}

export interface DbRow {
  id: number;
  slug: string;
  name: string;
  type: DbType;
  config: string;
  secrets_enc: string;
  desired_state: DesiredState;
  initialized: number;
  created_at: number;
  updated_at: number;
}

export interface Db extends Omit<DbRow, 'config' | 'secrets_enc'> {
  config: DbConfig;
}

export interface BackupRow {
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

export interface PanelSettings {
  port: number;
  access: 'private' | 'all' | 'custom';
  allowedCidrs: string[];
  baseUrl: string;
  timezoneNote?: string;
}

export interface Limits {
  total: Resources;
  apps: Resources;
  dbs: Resources;
}

export interface AlertSettings {
  diskPercent: number;
  memPercent: number;
  enabled: boolean;
}

export interface DefaultsSettings {
  pollIntervalSec: number;
  notify: NotifyPrefs;
}
