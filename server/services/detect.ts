import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from '../lib/types.ts';

export interface Detection {
  runtime: Runtime | null;
  runtimeVersion: string | null;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'uv' | null;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  notes: string[];
  files: string[];
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const exists = (dir: string, f: string) => fs.existsSync(path.join(dir, f));

export function nodeInstallCmd(dir: string) {
  if (exists(dir, 'pnpm-lock.yaml')) return { pm: 'pnpm' as const, cmd: 'pnpm install --frozen-lockfile --prod=false' };
  if (exists(dir, 'yarn.lock')) {
    const berry = exists(dir, '.yarnrc.yml');
    return { pm: 'yarn' as const, cmd: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile --production=false' };
  }
  if (exists(dir, 'bun.lockb') || exists(dir, 'bun.lock')) return { pm: 'bun' as const, cmd: 'npm install --include=dev' };
  if (exists(dir, 'package-lock.json') || exists(dir, 'npm-shrinkwrap.json')) return { pm: 'npm' as const, cmd: 'npm ci --include=dev' };
  return { pm: 'npm' as const, cmd: 'npm install --include=dev' };
}

export function pythonInstallCmd(dir: string) {
  if (exists(dir, 'uv.lock')) return { pm: 'uv' as const, cmd: 'uv sync --frozen --no-dev' };
  if (exists(dir, 'requirements.txt')) return { pm: 'pip' as const, cmd: 'uv pip install -r requirements.txt' };
  if (exists(dir, 'pyproject.toml')) return { pm: 'pip' as const, cmd: 'uv pip install -r pyproject.toml' };
  return { pm: 'pip' as const, cmd: '' };
}

/** 체크아웃한 폴더를 보고 런타임/명령을 추측한다 */
export function detect(dir: string): Detection {
  const d: Detection = {
    runtime: null,
    runtimeVersion: null,
    packageManager: null,
    installCmd: '',
    buildCmd: '',
    startCmd: '',
    notes: [],
    files: [],
  };
  try {
    d.files = fs.readdirSync(dir).filter((f) => !f.startsWith('.git')).slice(0, 200);
  } catch {
    return d;
  }
  const pkg = readJson(path.join(dir, 'package.json'));
  const isPython = ['requirements.txt', 'pyproject.toml', 'uv.lock', 'Pipfile', 'main.py', 'app.py', 'bot.py', 'manage.py'].some((f) =>
    exists(dir, f),
  );
  if (pkg) {
    d.runtime = 'node';
    const inst = nodeInstallCmd(dir);
    d.packageManager = inst.pm;
    d.installCmd = inst.cmd;
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const run = inst.pm === 'npm' || inst.pm === 'bun' ? 'npm run' : inst.pm;
    if (scripts.build) d.buildCmd = `${run} build`;
    if (scripts.start) d.startCmd = inst.pm === 'npm' || inst.pm === 'bun' ? 'npm start' : `${inst.pm} start`;
    else if (typeof pkg.main === 'string') d.startCmd = `node ${pkg.main}`;
    else if (exists(dir, 'index.js')) d.startCmd = 'node index.js';
    else if (exists(dir, 'server.js')) d.startCmd = 'node server.js';
    else if (exists(dir, 'app.js')) d.startCmd = 'node app.js';
    else d.notes.push('시작 명령을 찾지 못했습니다. package.json 에 "start" 스크립트를 넣거나 직접 입력하세요.');
    const engines = pkg.engines?.node as string | undefined;
    const nvmrc = ['.nvmrc', '.node-version'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    const spec = nvmrc ? fs.readFileSync(nvmrc, 'utf8').trim() : engines;
    const major = spec?.match(/(\d{2})/)?.[1];
    if (major) {
      d.runtimeVersion = major;
      d.notes.push(`Node ${major} 버전을 사용하도록 감지했습니다 (${nvmrc ? path.basename(nvmrc) : 'engines.node'}).`);
    }
    if (scripts.dev && !scripts.start) d.notes.push('"dev" 스크립트는 개발용입니다. 운영용 시작 명령을 확인하세요.');
    if (pkg.dependencies?.next) d.notes.push('Next.js: 시작 명령에 포트가 반영되도록 "next start -H 127.0.0.1 -p $PORT" 를 권장합니다.');
  } else if (isPython) {
    d.runtime = 'python';
    const inst = pythonInstallCmd(dir);
    d.packageManager = inst.pm;
    d.installCmd = inst.cmd;
    const pyver = ['.python-version'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (pyver) {
      const v = fs.readFileSync(pyver, 'utf8').trim().match(/^(\d+\.\d+)/)?.[1];
      if (v) {
        d.runtimeVersion = v;
        d.notes.push(`.python-version 에서 Python ${v} 을 감지했습니다.`);
      }
    }
    const req = (() => {
      try {
        return fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8').toLowerCase();
      } catch {
        try {
          return fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8').toLowerCase();
        } catch {
          return '';
        }
      }
    })();
    if (exists(dir, 'manage.py')) {
      const proj = d.files.find((f) => exists(dir, path.join(f, 'wsgi.py')));
      d.startCmd =
        req.includes('gunicorn') && proj
          ? `gunicorn --bind 127.0.0.1:$PORT ${proj}.wsgi`
          : 'python manage.py runserver 127.0.0.1:$PORT --noreload';
      d.notes.push('Django 프로젝트입니다. 마이그레이션은 "릴리스 명령"에 python manage.py migrate --noinput 을 넣으세요.');
    } else if (req.includes('uvicorn') || req.includes('fastapi')) {
      const mod = ['main', 'app', 'server'].find((m) => exists(dir, `${m}.py`)) ?? 'main';
      d.startCmd = `uvicorn ${mod}:app --host 127.0.0.1 --port $PORT`;
    } else if (req.includes('gunicorn') && (exists(dir, 'app.py') || exists(dir, 'wsgi.py'))) {
      d.startCmd = `gunicorn --bind 127.0.0.1:$PORT ${exists(dir, 'wsgi.py') ? 'wsgi' : 'app'}:app`;
    } else {
      const entry = ['main.py', 'app.py', 'bot.py', 'run.py', 'server.py', '__main__.py'].find((f) => exists(dir, f));
      if (entry) d.startCmd = `python ${entry}`;
      else d.notes.push('시작 파일(main.py 등)을 찾지 못했습니다. 시작 명령을 직접 입력하세요.');
    }
  } else {
    d.notes.push('Node.js(package.json) 또는 Python(requirements.txt/pyproject.toml/*.py) 프로젝트를 찾지 못했습니다. 루트 폴더 설정을 확인하세요.');
  }
  return d;
}

/** 의존성 해시에 쓰는 파일 목록 */
export function manifestFiles(runtime: Runtime) {
  return runtime === 'node'
    ? ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', '.npmrc', '.yarnrc.yml']
    : ['requirements.txt', 'requirements-prod.txt', 'pyproject.toml', 'uv.lock', 'setup.py', 'setup.cfg'];
}
