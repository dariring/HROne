import { ChevronRight, CornerLeftUp, Download, File, FileText, Folder, FolderOpen, Link2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ago, bytes } from '../lib/format';
import { setQuery, useLocation } from '../lib/router';
import { useApi } from '../lib/store';
import { Empty, ErrorBox, Loading, Toggle, cx } from './ui';

interface Entry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
  target?: string | null;
}

interface Preview {
  path: string;
  size: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const enc = encodeURIComponent;

/** 앱 폴더를 읽기 전용으로 둘러보고 내려받는다. 위치는 ?dir= / ?file= 로 주소에 남는다 */
export function FileBrowser({ slug }: { slug: string }) {
  const base = `/api/apps/${slug}/files`;
  const { query } = useLocation();
  const dir = query.get('dir') ?? '';
  const file = query.get('file');
  const [withDeps, setWithDeps] = useState(false);
  const { data, error, loading } = useApi<{ path: string; entries: Entry[]; truncated: boolean }>(`${base}?path=${enc(dir)}`);
  const viewer = useRef<HTMLDivElement>(null);

  const go = (d: string) => {
    setQuery('file', null);
    setQuery('dir', d || null);
  };
  const open = (f: string) => {
    setQuery('file', f);
    // 좁은 화면에서는 목록 아래에 열리므로 그쪽으로 내려 준다
    setTimeout(() => viewer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const crumbs = useMemo(() => {
    const parts = (data?.path ?? dir).split('/').filter(Boolean);
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  }, [data, dir]);

  if (error && !data) {
    return /아직 받아 온 파일이 없습니다/.test(error) ? (
      <div className="card">
        <Empty icon={<FolderOpen size={24} />} title="아직 파일이 없습니다">
          첫 배포가 끝나면 저장소 파일과 서버에서 생긴 파일(SQLite, 업로드 등)을 여기서 볼 수 있습니다.
        </Empty>
      </div>
    ) : (
      <ErrorBox error={error} onRetry={() => go('')} />
    );
  }

  const folderHref = `${base}/download?path=${enc(data?.path ?? dir)}${withDeps ? '&deps=1' : ''}`;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => go('')} className={cx('rounded-md px-1.5 py-0.5 font-medium hover:bg-surface-3 cursor-pointer', crumbs.length ? 'text-accent-2' : 'text-fg')}>
            {slug}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              <ChevronRight size={14} className="text-muted" />
              <button
                type="button"
                onClick={() => go(c.path)}
                className={cx('mono rounded-md px-1.5 py-0.5 hover:bg-surface-3 cursor-pointer', i === crumbs.length - 1 ? 'text-fg' : 'text-accent-2')}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={withDeps} onChange={setWithDeps} label={<span className="text-xs font-normal text-fg-2">node_modules 등 설치물 포함</span>} />
          <a href={folderHref} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-2">
            <Download size={14} />
            {crumbs.length ? '이 폴더 내려받기' : '전체 내려받기'}
          </a>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(260px,360px)_1fr]">
        <div className="card overflow-hidden">
          {loading && !data ? (
            <Loading />
          ) : (
            <div className="max-h-[70vh] divide-y divide-line overflow-auto">
              {dir && (
                <button type="button" onClick={() => go(crumbs.slice(0, -1).map((c) => c.name).join('/'))} className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-muted hover:bg-surface-2 cursor-pointer">
                  <CornerLeftUp size={15} />
                  상위 폴더
                </button>
              )}
              {data?.entries.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted">빈 폴더입니다</div>}
              {data?.entries.map((e) => {
                const p = join(data.path, e.name);
                const active = file === p;
                const Icon = e.type === 'dir' ? Folder : e.type === 'link' ? Link2 : /\.(md|txt|json|ya?ml|toml|ini|env|js|ts|tsx|jsx|py|sh|css|html|sql|cfg|conf|lock)$/i.test(e.name) || e.name.startsWith('.') ? FileText : File;
                const clickable = e.type === 'dir' || e.type === 'file';
                return (
                  <button
                    key={e.name}
                    type="button"
                    disabled={!clickable}
                    title={e.type === 'link' ? (e.target === null ? '앱 폴더 밖을 가리키는 링크라 열 수 없습니다' : `→ ${e.target}`) : undefined}
                    onClick={() => (e.type === 'dir' ? go(e.target ?? p) : open(p))}
                    className={cx('flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm', active ? 'bg-accent/15' : 'hover:bg-surface-2', clickable ? 'cursor-pointer' : 'cursor-default opacity-60')}
                  >
                    <Icon size={15} className={cx('shrink-0', e.type === 'dir' ? 'text-accent-2' : 'text-muted')} />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {e.type === 'file' && <span className="shrink-0 text-xs text-muted">{bytes(e.size)}</span>}
                  </button>
                );
              })}
              {data?.truncated && <div className="px-4 py-2 text-xs text-muted">항목이 많아 앞 3,000개만 보여 줍니다</div>}
            </div>
          )}
        </div>

        <div ref={viewer} className="min-w-0 scroll-mt-4">
          {file ? (
            <FileView base={base} path={file} />
          ) : (
            <div className="card hidden h-full min-h-[200px] items-center justify-center px-6 py-10 text-center text-sm text-muted lg:flex">
              왼쪽에서 파일을 고르면 내용을 볼 수 있습니다. 서버에서 생긴 파일(SQLite, 업로드, .env 등)도 여기 있습니다.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileView({ base, path }: { base: string; path: string }) {
  const { data, error, loading } = useApi<Preview>(`${base}/content?path=${enc(path)}`);
  const [wrap, setWrap] = useState(false);
  useEffect(() => setWrap(false), [path]);
  const lines = data?.text?.split('\n') ?? [];
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const href = `${base}/download?path=${enc(path)}`;
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="mono truncate text-[13px]">{path}</div>
          {data && (
            <div className="text-xs text-muted">
              {bytes(data.size)} · {ago(data.mtime)} 수정{data.text !== null ? ` · ${lines.length.toLocaleString()}줄` : ''}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {data?.text !== null && data && <Toggle checked={wrap} onChange={setWrap} label={<span className="text-xs font-normal text-fg-2">줄바꿈</span>} />}
          <a href={href} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-fill px-3 text-[13px] font-medium hover:bg-fill-strong/50">
            <Download size={14} />
            내려받기
          </a>
        </div>
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <div className="p-4">
          <ErrorBox error={error} />
        </div>
      ) : data?.binary ? (
        <div className="px-6 py-12 text-center text-sm text-muted">텍스트가 아닌 파일이라 미리 볼 수 없습니다 (SQLite DB, 이미지 등). 내려받아서 여세요.</div>
      ) : (
        <>
          {data?.truncated && <div className="border-b border-line bg-warn/10 px-4 py-1.5 text-xs text-warn">파일이 커서 앞 1MB 만 보여 줍니다. 전체는 내려받아서 보세요.</div>}
          <div className="max-h-[70vh] overflow-auto bg-code">
            <div className="mono flex min-w-full text-[12.5px] leading-[1.6]">
              {/* 줄바꿈을 켜면 줄 번호가 어긋나므로 숨긴다 */}
              {!wrap && <pre className="sticky left-0 select-none border-r border-line bg-code px-3 py-3 text-right text-muted/70">{lines.map((_, i) => i + 1).join('\n')}</pre>}
              <pre className={cx('min-w-0 flex-1 px-4 py-3 text-fg-2', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>{lines.join('\n') || ' '}</pre>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
