import path from 'node:path';

/** 패널 코드 루트 (/opt/hrone) */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** 모든 상태/데이터 루트. 백업은 이 폴더 하나만 챙기면 된다. */
export const DATA = process.env.HRONE_DATA ?? '/var/lib/hrone';

export const PATHS = {
  db: path.join(DATA, 'hrone.db'),
  secretKey: path.join(DATA, 'secret.key'),
  apps: path.join(DATA, 'apps'),
  appdata: path.join(DATA, 'appdata'),
  databases: path.join(DATA, 'databases'),
  backups: path.join(DATA, 'backups'),
  logs: path.join(DATA, 'logs'),
  deployLogs: path.join(DATA, 'logs', 'deploys'),
  runtimes: path.join(DATA, 'runtimes'),
  nodeRuntimes: path.join(DATA, 'runtimes', 'node'),
  pythonRuntimes: path.join(DATA, 'runtimes', 'python'),
  bin: path.join(DATA, 'runtimes', 'bin'),
  tmp: path.join(DATA, 'tmp'),
  webDist: path.join(ROOT, 'web', 'dist'),
  unitDir: process.env.HRONE_UNIT_DIR ?? '/etc/systemd/system',
};

export const appDir = (slug: string) => path.join(PATHS.apps, slug);
export const appDataDir = (slug: string) => path.join(PATHS.appdata, slug);
export const dbDir = (slug: string) => path.join(PATHS.databases, slug);

export const UNIT = {
  panel: 'hrone.service',
  rootSlice: 'hrone.slice',
  appsSlice: 'hrone-apps.slice',
  dbsSlice: 'hrone-dbs.slice',
  app: (slug: string) => `hrone-app-${slug}.service`,
  db: (slug: string) => `hrone-db-${slug}.service`,
};

/** 앱 프로세스를 실행하는 리눅스 계정 */
export const appUser = (slug: string) => `hr-${slug}`;
