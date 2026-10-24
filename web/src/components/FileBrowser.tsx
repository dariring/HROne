import { ChevronRight, CornerLeftUp, Download, File, FilePlus, FileText, Folder, FolderOpen, GitCommitHorizontal, Link2, Pencil, Save, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorText } from '../lib/api';
import { ago, bytes } from '../lib/format';
import { setQuery, useLocation } from '../lib/router';
import { useApi } from '../lib/store';
import { Button, Empty, ErrorBox, Field, Loading, Modal, Notice, Toggle, cx, toast, useConfirm } from './ui';

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

interface Changed {
  path: string;
  code: string;
  kind: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'other';
  preserved: boolean;
}

interface GitStatus {
  branch: string;
  head: string;
  ahead: number;
  unpushed: { sha: string; message: string }[];
  files: Changed[];
  truncated: boolean;
  auth: 'none' | 'token' | 'deploykey';
  localChanges: 'overwrite' | 'keep';
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const enc = encodeURIComponent;

const KIND: Record<Changed['kind'], { label: string; cls: string }> = {
  modified: { label: '수정', cls: 'text-warn' },
  added: { label: '새 파일', cls: 'text-ok' },
  untracked: { label: '새 파일', cls: 'text-ok' },
  deleted: { label: '삭제', cls: 'text-bad' },
  renamed: { label: '이름 바뀜', cls: 'text-info' },
  other: { label: '바뀜', cls: 'text-muted' },
};

/**
 * 앱 폴더를 둘러보고, 고쳐서 저장하고, 커밋해서 GitHub 에 올린다.
 * 위치는 ?dir= / ?file= 로 주소에 남는다.
 */
export function FileBrowser({ slug, canRestart, deployLabel }: { slug: string; canRestart: boolean; deployLabel: string }) {
  const base = `/api/apps/${slug}/files`;
  const { query } = useLocation();
  const dir = query.get('dir') ?? '';
  const file = query.get('file');
  const [withDeps, setWithDeps] = useState(false);
  const { data, error, loading, reload } = useApi<{ path: string; entries: Entry[]; truncated: boolean }>(`${base}?path=${enc(dir)}`);
  const { data: git, reload: reloadGit } = useApi<GitStatus>(`/api/apps/${slug}/git/status`, { refreshOn: ['deploys'] });
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const viewer = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();

  // 저장하지 않은 수정이 있으면 창을 닫거나 다른 파일로 갈 때 묻는다
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);
  const canLeave = async () => !dirty || (await confirm({ title: '저장하지 않은 수정', body: '고친 내용을 저장하지 않고 나갈까요?', confirm: '버리고 나가기', danger: true }));

  const go = async (d: string) => {
    if (!(await canLeave())) return;
    setDirty(false);
    setQuery('file', null);
    setQuery('dir', d || null);
  };
  const open = async (f: string) => {
    if (f !== file && !(await canLeave())) return;
    setDirty(false);
    setQuery('file', f);
    // 좁은 화면에서는 목록 아래에 열리므로 그쪽으로 내려 준다
    setTimeout(() => viewer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const crumbs = useMemo(() => {
    const parts = (data?.path ?? dir).split('/').filter(Boolean);
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  }, [data, dir]);
  const changed = useMemo(() => new Map((git?.files ?? []).map((f) => [f.path, f])), [git]);
  const dirChanged = (p: string) => (git?.files ?? []).some((f) => f.path.startsWith(p + '/'));
  const afterChange = () => {
    reload();
    reloadGit();
  };

  if (error && !data) {
    return /아직 받아 온 파일이 없습니다/.test(error) ? (
      <div className="card">
        <Empty icon={<FolderOpen size={24} />} title="아직 파일이 없습니다">
          첫 배포가 끝나면 저장소 파일과 서버에서 생긴 파일(SQLite, 업로드 등)을 여기서 볼 수 있습니다.
        </Empty>
      </div>
    ) : (
      <ErrorBox error={error} onRetry={() => void go('')} />
    );
  }

  const here = data?.path ?? dir;
  const folderHref = `${base}/download?path=${enc(here)}${withDeps ? '&deps=1' : ''}`;
  const pending = (git?.files.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      {git && (pending || git.ahead > 0) && (
        <div className="card flex flex-wrap items-center justify-between gap-3 border-warn/30 px-4 py-3">
          <div className="min-w-0 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <GitCommitHorizontal size={16} className="text-warn" />
              {pending && <span>GitHub 에 올리지 않은 수정 파일 {git.files.length}개</span>}
              {git.ahead > 0 && <span>올리지 않은 커밋 {git.ahead}개</span>}
            </div>
            {pending && git.localChanges === 'overwrite' && (
              <div className="mt-1 text-xs text-muted">커밋해서 올리지 않으면 다음 배포 때 저장소 버전으로 바뀝니다 (고친 파일은 백업에 남습니다).</div>
            )}
          </div>
          <Button variant="primary" size="sm" icon={pending ? <GitCommitHorizontal size={14} /> : <Upload size={14} />} onClick={() => setCommitting(true)}>
            {pending ? '커밋 · 올리기' : `올리기 (${git.ahead})`}
          </Button>
        </div>
      )}

      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => void go('')} className={cx('rounded-md px-1.5 py-0.5 font-medium hover:bg-surface-3 cursor-pointer', crumbs.length ? 'text-accent-2' : 'text-fg')}>
            {slug}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              <ChevronRight size={14} className="text-muted" />
              <button
                type="button"
                onClick={() => void go(c.path)}
                className={cx('mono rounded-md px-1.5 py-0.5 hover:bg-surface-3 cursor-pointer', i === crumbs.length - 1 ? 'text-fg' : 'text-accent-2')}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={withDeps} onChange={setWithDeps} label={<span className="text-xs font-normal text-fg-2">node_modules 등 포함</span>} />
          <Button size="sm" icon={<FilePlus size={14} />} onClick={() => setCreating(true)}>
            새 파일
          </Button>
          <a href={folderHref} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-fill px-3 text-[13px] font-medium hover:bg-fill-strong/50">
            <Download size={14} />
            {crumbs.length ? '이 폴더 내려받기' : '전체 내려받기'}
          </a>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
        <div className="card overflow-hidden">
          {loading && !data ? (
            <Loading />
          ) : (
            <div className="max-h-[75vh] divide-y divide-line overflow-auto">
              {dir && (
                <button type="button" onClick={() => void go(crumbs.slice(0, -1).map((c) => c.name).join('/'))} className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-muted hover:bg-surface-2 cursor-pointer">
                  <CornerLeftUp size={15} />
                  상위 폴더
                </button>
              )}
              {data?.entries.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted">빈 폴더입니다</div>}
              {data?.entries.map((e) => {
                const p = join(data.path, e.name);
                const active = file === p;
                const Icon = e.type === 'dir' ? Folder : e.type === 'link' ? Link2 : /\.(md|txt|json|ya?ml|toml|ini|env|js|mjs|cjs|ts|tsx|jsx|py|sh|css|html|sql|cfg|conf|lock)$/i.test(e.name) || e.name.startsWith('.') ? FileText : File;
                const clickable = e.type === 'dir' || e.type === 'file';
                const ch = e.type === 'dir' ? (dirChanged(p) ? KIND.modified : null) : changed.has(p) ? KIND[changed.get(p)!.kind] : null;
                return (
                  <button
                    key={e.name}
                    type="button"
                    disabled={!clickable}
                    title={e.type === 'link' ? (e.target === null ? '앱 폴더 밖을 가리키는 링크라 열 수 없습니다' : `→ ${e.target}`) : ch ? `${ch.label} (GitHub 에 올리지 않음)` : undefined}
                    onClick={() => void (e.type === 'dir' ? go(e.target ?? p) : open(p))}
                    className={cx('flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm', active ? 'bg-accent/15' : 'hover:bg-surface-2', clickable ? 'cursor-pointer' : 'cursor-default opacity-60')}
                  >
                    <Icon size={15} className={cx('shrink-0', e.type === 'dir' ? 'text-accent-2' : 'text-muted')} />
                    <span className={cx('min-w-0 flex-1 truncate', ch?.cls)}>{e.name}</span>
                    {ch && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full bg-current', ch.cls)} />}
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
            <FileView key={file} slug={slug} base={base} path={file} canRestart={canRestart} onDirty={setDirty} onSaved={afterChange} />
          ) : (
            <div className="card hidden h-full min-h-[200px] items-center justify-center px-6 py-10 text-center text-sm text-muted lg:flex">
              왼쪽에서 파일을 고르면 내용을 보고 고칠 수 있습니다. 서버에서 생긴 파일(SQLite, 업로드, .env 등)도 여기 있습니다.
            </div>
          )}
        </div>
      </div>

      <NewFileDialog
        open={creating}
        dir={here}
        base={base}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          afterChange();
          setDirty(false);
          setQuery('file', p);
        }}
      />
      {git && <CommitDialog open={committing} slug={slug} git={git} mode={deployLabel} onClose={() => setCommitting(false)} onDone={afterChange} />}
    </div>
  );
}

function FileView({ slug, base, path, canRestart, onDirty, onSaved }: { slug: string; base: string; path: string; canRestart: boolean; onDirty: (v: boolean) => void; onSaved: () => void }) {
  const { data, error, loading, reload } = useApi<Preview>(`${base}/content?path=${enc(path)}`);
  const [wrap, setWrap] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  const lines = data?.text?.split('\n') ?? [];
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const href = `${base}/download?path=${enc(path)}`;
  const editable = !!data && data.text !== null && !data.truncated;
  const editing = draft !== null;
  const dirty = editing && draft !== data?.text;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const save = async () => {
    if (!data || draft === null) return;
    setSaving(true);
    try {
      await api.put(`${base}/content`, { path, text: draft, mtime: data.mtime });
      if (restart && canRestart) {
        await api.post(`/api/apps/${slug}/action`, { action: 'restart' });
        toast.ok('저장하고 앱을 재시작했습니다');
      } else toast.ok('저장했습니다');
      setDraft(null);
      reload();
      onSaved();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (dirty && !saving) void save();
      return;
    }
    // Tab 은 칸 이동 대신 들여쓰기 (파일이 탭을 쓰면 탭, 아니면 공백 2칸)
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const ta = e.currentTarget;
      const indent = /^\t/m.test(draft ?? '') ? '\t' : '  ';
      const { selectionStart: a, selectionEnd: b, value } = ta;
      const next = value.slice(0, a) + indent + value.slice(b);
      setDraft(next);
      requestAnimationFrame(() => ta.setSelectionRange(a + indent.length, a + indent.length));
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="mono truncate text-[13px]">
            {path}
            {dirty && <span className="ml-2 text-warn">● 저장 안 됨</span>}
          </div>
          {data && (
            <div className="text-xs text-muted">
              {bytes(data.size)} · {ago(data.mtime)} 수정{data.text !== null ? ` · ${lines.length.toLocaleString()}줄` : ''}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              {canRestart && <Toggle checked={restart} onChange={setRestart} label={<span className="text-xs font-normal text-fg-2">저장 후 앱 재시작</span>} />}
              <Button
                size="sm"
                variant="ghost"
                icon={<X size={14} />}
                disabled={saving}
                onClick={async () => {
                  if (dirty && !(await confirm({ title: '수정 취소', body: '고친 내용을 버릴까요?', confirm: '버리기', danger: true }))) return;
                  setDraft(null);
                }}
              >
                취소
              </Button>
              <Button size="sm" variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={() => void save()}>
                저장 <span className="text-[11px] opacity-70">⌘S</span>
              </Button>
            </>
          ) : (
            <>
              {data?.text !== null && data && <Toggle checked={wrap} onChange={setWrap} label={<span className="text-xs font-normal text-fg-2">줄바꿈</span>} />}
              {editable && (
                <Button size="sm" icon={<Pencil size={14} />} onClick={() => setDraft(data!.text!)}>
                  수정
                </Button>
              )}
              <a href={href} className="inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-fill px-3 text-[13px] font-medium hover:bg-fill-strong/50">
                <Download size={14} />
                내려받기
              </a>
            </>
          )}
        </div>
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <div className="p-4">
          <ErrorBox error={error} />
        </div>
      ) : data?.binary ? (
        <div className="px-6 py-12 text-center text-sm text-muted">텍스트가 아닌 파일이라 미리 보거나 고칠 수 없습니다 (SQLite DB, 이미지 등). 내려받아서 여세요.</div>
      ) : editing ? (
        <textarea
          className="mono block h-[70vh] w-full resize-none bg-code px-4 py-3 text-[12.5px] leading-[1.6] text-fg outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          wrap={wrap ? 'soft' : 'off'}
          spellCheck={false}
          autoFocus
        />
      ) : (
        <>
          {data?.truncated && <div className="border-b border-line bg-warn/10 px-4 py-1.5 text-xs text-warn">파일이 커서 앞 1MB 만 보여 주며, 웹에서는 고칠 수 없습니다. 전체는 내려받아서 보세요.</div>}
          <div className="max-h-[70vh] overflow-auto bg-code" onDoubleClick={() => editable && setDraft(data!.text!)}>
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

function NewFileDialog({ open, dir, base, onClose, onCreated }: { open: boolean; dir: string; base: string; onClose: () => void; onCreated: (path: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ path: string }>(`${base}/create`, { dir, name: name.trim() });
      toast.ok('파일을 만들었습니다');
      onCreated(r.path);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="새 파일"
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || /[/\\]/.test(name)} onClick={() => void create()}>
            만들기
          </Button>
        </>
      }
    >
      <Field label="파일 이름" hint={`만들 위치: ${dir ? `${dir}/` : '앱 폴더 맨 위'}`}>
        <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} placeholder="config.json" autoFocus />
      </Field>
    </Modal>
  );
}

function CommitDialog({ open, slug, git, mode, onClose, onDone }: { open: boolean; slug: string; git: GitStatus; mode: string; onClose: () => void; onDone: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  useEffect(() => {
    if (!open) return;
    // 서버에 남길 파일(SQLite 등)은 기본으로 빼 둔다
    const def = git.files.filter((f) => !f.preserved).map((f) => f.path);
    setPicked(new Set(def));
    const names = def.slice(0, 3).map((p) => p.split('/').pop());
    setMessage(def.length ? `웹에서 수정: ${names.join(', ')}${def.length > 3 ? ` 외 ${def.length - 3}개` : ''}` : '');
  }, [open, git]);
  const canPush = git.auth !== 'none';

  const submit = async (push: boolean) => {
    setBusy(push ? 'push' : 'commit');
    try {
      if (picked.size) {
        const r = await api.post<{ sha: string; pushed: boolean }>(`/api/apps/${slug}/git/commit`, { files: [...picked], message, push });
        toast.ok(r.pushed ? `커밋 ${r.sha} 을 GitHub 에 올렸습니다. ${mode} 방식으로 배포됩니다.` : `커밋 ${r.sha} 을 만들었습니다. 올리기 전까지는 GitHub 에 없습니다.`);
      } else {
        await api.post(`/api/apps/${slug}/git/push`);
        toast.ok(`GitHub 에 올렸습니다. ${mode} 방식으로 배포됩니다.`);
      }
      onDone();
      onClose();
    } catch (e) {
      toast.error(errorText(e));
      // 커밋까지는 됐을 수 있으니 상태를 다시 읽는다
      onDone();
    } finally {
      setBusy(null);
    }
  };

  const toggle = (p: string, on: boolean) => {
    const n = new Set(picked);
    if (on) n.add(p);
    else n.delete(p);
    setPicked(n);
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={`GitHub 에 올리기 (${git.branch} 브랜치)`}
      width={600}
      footer={
        <>
          <Button variant="ghost" disabled={!!busy} onClick={onClose}>
            취소
          </Button>
          {git.files.length > 0 && (
            <Button loading={busy === 'commit'} disabled={!!busy || !picked.size || !message.trim()} onClick={() => void submit(false)}>
              커밋만
            </Button>
          )}
          <Button variant="primary" icon={<Upload size={15} />} loading={busy === 'push'} disabled={!!busy || !canPush || (picked.size > 0 ? !message.trim() : git.ahead === 0)} onClick={() => void submit(true)}>
            {picked.size ? '커밋하고 올리기' : '올리기'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {!canPush && (
          <Notice tone="yellow" title="이 앱은 GitHub 에 올릴 수 없습니다">
            공개 저장소로(인증 없이) 연결되어 있습니다. 앱 설정 → 저장소에서 쓰기 권한이 있는 GitHub 토큰(Contents: Read and write)이나 쓰기 허용 배포 키로 바꾸면 올릴 수 있습니다. 커밋은 지금도 됩니다.
          </Notice>
        )}
        {git.files.length > 0 && (
          <>
            <div>
              <div className="label">올릴 파일</div>
              <div className="max-h-64 divide-y divide-line overflow-auto rounded-xl bg-fill">
                {git.files.map((f) => (
                  <label key={f.path} className="flex cursor-pointer items-center gap-3 px-3 py-2">
                    <input type="checkbox" className="accent-[var(--color-accent)]" checked={picked.has(f.path)} onChange={(e) => toggle(f.path, e.target.checked)} />
                    <span className="mono min-w-0 flex-1 truncate text-[12.5px]">{f.path}</span>
                    {f.preserved && <span className="shrink-0 text-xs text-muted">서버 데이터</span>}
                    <span className={cx('shrink-0 text-xs', KIND[f.kind].cls)}>{KIND[f.kind].label}</span>
                  </label>
                ))}
              </div>
              {git.files.some((f) => f.preserved) && <div className="hint">"서버 데이터" 는 설정의 "서버에 남길 파일" 에 해당하는 파일(DB 파일 등)입니다. 보통은 올리지 않습니다.</div>}
            </div>
            <Field label="커밋 메시지">
              <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
          </>
        )}
        {git.unpushed.length > 0 && (
          <div>
            <div className="label">아직 올리지 않은 커밋</div>
            <div className="space-y-1 rounded-xl bg-fill p-3">
              {git.unpushed.map((c) => (
                <div key={c.sha} className="flex gap-2 text-[13px]">
                  <span className="mono text-accent-2">{c.sha}</span>
                  <span className="min-w-0 flex-1 truncate">{c.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-muted">올리면 평소 GitHub 푸시와 똑같이 이 앱의 배포 방식({mode})대로 배포됩니다. GitHub 에 더 새 커밋이 있으면 덮어쓰지 않고 멈춥니다.</p>
      </div>
    </Modal>
  );
}
