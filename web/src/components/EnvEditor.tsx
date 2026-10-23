import { ChevronDown, ChevronRight, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/store';
import { Badge, Button, Card, ErrorBox, IconButton, Loading, Segmented, toast, Toggle, cx } from './ui';

interface EnvVar {
  key: string;
  value: string;
}

interface EnvData {
  vars: EnvVar[];
  linked: EnvVar[];
  system: EnvVar[];
  text: string;
}

function parseDotenv(text: string): EnvVar[] {
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
    const q = value[0];
    if (q === '"' || q === "'" || q === '`') {
      let body = value.slice(1);
      while (!body.endsWith(q) && i + 1 < lines.length) body += '\n' + lines[++i];
      value = body.endsWith(q) ? body.slice(0, -1) : body;
      if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else value = value.replace(/\s+#.*$/, '');
    out.push({ key, value });
  }
  return out;
}

const SENSITIVE = /(SECRET|TOKEN|PASSWORD|PASS|KEY|PRIVATE|CREDENTIAL|DSN|DATABASE_URL|REDIS_URL)/i;

export function EnvEditor({ slug, running }: { slug: string; running: boolean }) {
  const { data, error, loading, reload } = useApi<EnvData>(`/api/apps/${slug}/env`);
  const [mode, setMode] = useState<'table' | 'raw'>('table');
  const [rows, setRows] = useState<EnvVar[]>([]);
  const [raw, setRaw] = useState('');
  const [reveal, setReveal] = useState<Set<number>>(new Set());
  const [restart, setRestart] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSystem, setShowSystem] = useState(false);

  useEffect(() => {
    if (!data) return;
    setRows(data.vars.length ? data.vars : [{ key: '', value: '' }]);
    setRaw(data.text);
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    const cur = mode === 'table' ? rows.filter((r) => r.key.trim()) : parseDotenv(raw);
    return JSON.stringify(cur) !== JSON.stringify(data.vars);
  }, [data, rows, raw, mode]);

  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox error={error ?? '불러오기 실패'} onRetry={reload} />;

  const switchMode = (m: 'table' | 'raw') => {
    if (m === mode) return;
    if (m === 'raw') {
      setRaw(
        rows
          .filter((r) => r.key.trim())
          .map((r) => (/^[\w@%+=:,./-]*$/.test(r.value) ? `${r.key}=${r.value}` : `${r.key}="${r.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`))
          .join('\n'),
      );
    } else {
      const parsed = parseDotenv(raw);
      setRows(parsed.length ? parsed : [{ key: '', value: '' }]);
    }
    setMode(m);
  };

  const save = async () => {
    setSaving(true);
    try {
      const vars = mode === 'table' ? rows.filter((r) => r.key.trim()) : parseDotenv(raw);
      const r = await api.put<{ count: number; restartNeeded: boolean }>(`/api/apps/${slug}/env`, { vars, restart: restart && running });
      toast.ok(`환경변수 ${r.count}개 저장${restart && running ? ' · 앱을 재시작했습니다' : r.restartNeeded ? ' · 재시작하면 반영됩니다' : ''}`);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card
        title="환경변수"
        actions={
          <Segmented
            value={mode}
            onChange={switchMode}
            options={[
              { value: 'table', label: '표' },
              { value: 'raw', label: '.env 텍스트' },
            ]}
          />
        }
      >
        {mode === 'table' ? (
          <div className="space-y-2">
            {rows.map((r, i) => {
              const secret = SENSITIVE.test(r.key) && !reveal.has(i);
              return (
                <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <input
                    className="input mono sm:w-[34%]"
                    placeholder="KEY"
                    value={r.key}
                    spellCheck={false}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/\s/g, '') } : x)))}
                    onPaste={(e) => {
                      const t = e.clipboardData.getData('text');
                      if (t.includes('\n') && t.includes('=')) {
                        e.preventDefault();
                        const parsed = parseDotenv(t);
                        const merged = [...rows.filter((x) => x.key.trim() && !parsed.some((p) => p.key === x.key)), ...parsed];
                        setRows(merged);
                        toast.info(`${parsed.length}개를 붙여넣었습니다`);
                      }
                    }}
                  />
                  <div className="relative flex-1">
                    {r.value.includes('\n') ? (
                      <textarea
                        className={cx('input mono min-h-[70px] pr-10', secret && 'text-transparent [text-shadow:0_0_7px_var(--color-fg-2)]')}
                        value={r.value}
                        spellCheck={false}
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      />
                    ) : (
                      <input
                        className="input mono pr-10"
                        type={secret ? 'password' : 'text'}
                        placeholder="값"
                        value={r.value}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      />
                    )}
                    {SENSITIVE.test(r.key) && (
                      <button
                        type="button"
                        className="absolute right-2 top-2 rounded p-1 text-muted hover:text-fg cursor-pointer"
                        onClick={() => {
                          const n = new Set(reveal);
                          n.has(i) ? n.delete(i) : n.add(i);
                          setReveal(n);
                        }}
                        title={secret ? '보기' : '숨기기'}
                      >
                        {secret ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                    )}
                  </div>
                  <IconButton title="삭제" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ key: '', value: '' }])}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              );
            })}
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setRows([...rows, { key: '', value: '' }])}>
                추가
              </Button>
              <span className="text-xs text-muted">KEY 칸에 .env 내용을 통째로 붙여넣어도 됩니다</span>
            </div>
          </div>
        ) : (
          <textarea
            className="input mono min-h-[320px] text-[13px] leading-relaxed"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            spellCheck={false}
            placeholder={'# KEY=VALUE 형식\nDISCORD_TOKEN=...\nAPI_URL="https://example.com"'}
          />
        )}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <Toggle checked={restart} onChange={setRestart} label="저장 후 앱 재시작" sub={running ? '환경변수는 재시작해야 반영됩니다' : '앱이 꺼져 있어 다음 시작 때 반영됩니다'} disabled={!running} />
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
            저장
          </Button>
        </div>
      </Card>

      {data.linked.length > 0 && (
        <Card title={<span className="flex items-center gap-2">연결된 DB 가 넣어 주는 변수 <Badge tone="purple">자동</Badge></span>}>
          <div className="grid gap-1.5 text-[13px]">
            {data.linked.map((v) => (
              <div key={v.key} className="mono flex gap-3">
                <span className="w-56 shrink-0 text-accent-2">{v.key}</span>
                <span className="truncate text-muted">{SENSITIVE.test(v.key) ? '••••••••' : v.value}</span>
              </div>
            ))}
          </div>
          <div className="hint mt-3">같은 이름을 위 표에 직접 넣으면 그 값이 우선합니다.</div>
        </Card>
      )}

      <div className="card">
        <button type="button" className="flex w-full items-center gap-2 px-5 py-3.5 text-sm font-semibold cursor-pointer" onClick={() => setShowSystem(!showSystem)}>
          {showSystem ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          패널이 기본으로 넣는 변수 <span className="font-normal text-muted">({data.system.length}개 · PORT, HOST 등)</span>
        </button>
        {showSystem && (
          <div className="grid gap-1.5 border-t border-line px-5 py-4 text-[13px]">
            {data.system.map((v) => (
              <div key={v.key} className="mono flex gap-3">
                <span className="w-56 shrink-0 text-fg-2">{v.key}</span>
                <span className="break-all text-muted">{v.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
