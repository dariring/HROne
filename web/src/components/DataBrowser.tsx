import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Eye, KeyRound, RefreshCw, Search, Table2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { bytes } from '../lib/format';
import { setQuery, useLocation } from '../lib/router';
import { useApi } from '../lib/store';
import { Button, CopyButton, Empty, ErrorBox, IconButton, Loading, Modal, cx } from './ui';

interface Column {
  name: string;
  type: string;
  columnType: string;
  key: string;
  nullable: boolean;
}

interface Page {
  columns: Column[];
  rows: (string | null)[][];
  page: number;
  size: number;
  hasMore: boolean;
  total: number | null;
  exact: boolean;
}

const enc = encodeURIComponent;

/** MariaDB 테이블을 읽기 전용으로 본다. 고른 DB/테이블은 ?schema= / ?table= 로 주소에 남는다 */
export function DataBrowser({ slug, defaultDb, running }: { slug: string; defaultDb: string; running: boolean }) {
  const { query } = useLocation();
  const { data: schemas } = useApi<{ name: string; tables: number }[]>(running ? `/api/databases/${slug}/schemas` : null);
  const schema = query.get('schema') ?? (schemas?.some((s) => s.name === defaultDb) ? defaultDb : schemas?.[0]?.name ?? '');
  const table = query.get('table');
  const { data: tables, error } = useApi<{ name: string; view: boolean; rows: number; size: number }[]>(running && schema ? `/api/databases/${slug}/schemas/${enc(schema)}/tables` : null);

  if (!running) {
    return (
      <div className="card">
        <Empty icon={<Table2 size={24} />} title="DB 가 실행 중이 아닙니다">
          시작하면 테이블과 데이터를 볼 수 있습니다.
        </Empty>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
      <div className="card overflow-hidden">
        <div className="border-b border-line p-3">
          <select
            className="input"
            value={schema}
            onChange={(e) => {
              setQuery('table', null);
              setQuery('schema', e.target.value);
            }}
          >
            {(schemas ?? []).map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.tables})
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <div className="p-3">
            <ErrorBox error={error} />
          </div>
        ) : !tables ? (
          <Loading />
        ) : tables.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted">테이블이 없습니다</div>
        ) : (
          <div className="max-h-[70vh] divide-y divide-line overflow-auto">
            {tables.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => setQuery('table', t.name)}
                className={cx('flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm cursor-pointer', table === t.name ? 'bg-accent/15' : 'hover:bg-surface-2')}
              >
                {t.view ? <Eye size={15} className="shrink-0 text-muted" /> : <Table2 size={15} className="shrink-0 text-accent-2" />}
                <span className="mono min-w-0 flex-1 truncate">{t.name}</span>
                <span className="shrink-0 text-xs text-muted" title={t.view ? '뷰' : `약 ${t.rows.toLocaleString()}행 · ${bytes(t.size)}`}>
                  {t.view ? '뷰' : `~${t.rows.toLocaleString()}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-w-0">
        {table ? (
          <TableView key={`${schema}.${table}`} slug={slug} schema={schema} table={table} />
        ) : (
          <div className="card flex min-h-[200px] items-center justify-center px-6 py-10 text-center text-sm text-muted">
            테이블을 고르면 데이터를 볼 수 있습니다. 읽기 전용이며, 데이터를 바꾸려면 SQL 콘솔을 쓰세요.
          </div>
        )}
      </div>
    </div>
  );
}

function TableView({ slug, schema, table }: { slug: string; schema: string; table: string }) {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const [order, setOrder] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  const [filterCol, setFilterCol] = useState('');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<{ col: string; q: string } | null>(null);
  const [detail, setDetail] = useState<(string | null)[] | null>(null);
  const qs = new URLSearchParams({ page: String(page), size: String(size) });
  if (order) {
    qs.set('order', order.col);
    qs.set('dir', order.dir);
  }
  if (filter) {
    qs.set('fcol', filter.col);
    qs.set('q', filter.q);
  }
  const { data, error, loading, reload } = useApi<Page>(`/api/databases/${slug}/schemas/${enc(schema)}/tables/${enc(table)}/rows?${qs}`);
  useEffect(() => {
    if (data && !filterCol) setFilterCol(data.columns.find((c) => /char|text/.test(c.type))?.name ?? data.columns[0]?.name ?? '');
  }, [data, filterCol]);

  const cols = data?.columns ?? [];
  const sortBy = (col: string) => {
    setPage(0);
    setOrder((o) => (o?.col !== col ? { col, dir: 'asc' } : o.dir === 'asc' ? { col, dir: 'desc' } : null));
  };
  const from = data ? data.page * data.size + 1 : 0;
  const to = data ? data.page * data.size + data.rows.length : 0;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="mono truncate text-[13px]">
            <span className="text-muted">{schema}.</span>
            {table}
          </div>
          {data && <div className="text-xs text-muted">{data.total === null ? '행 수 계산 안 함' : `${data.exact ? '' : '약 '}${data.total.toLocaleString()}행`} · 컬럼 {cols.length}개 · 읽기 전용</div>}
        </div>
        <div className="flex items-center gap-2">
          <select className="input h-8 w-auto py-0 text-[13px]" value={size} onChange={(e) => (setSize(Number(e.target.value)), setPage(0))}>
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}줄씩
              </option>
            ))}
          </select>
          <IconButton title="새로고침" onClick={reload}>
            <RefreshCw size={15} />
          </IconButton>
        </div>
      </div>

      <form
        className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setFilter(text.trim() && filterCol ? { col: filterCol, q: text.trim() } : null);
        }}
      >
        <select className="input h-8 w-auto max-w-[180px] py-0 text-[13px]" value={filterCol} onChange={(e) => setFilterCol(e.target.value)}>
          {cols.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="relative min-w-[160px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input h-8 pl-8 text-[13px]" placeholder="이 값을 포함하는 행 찾기" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Button size="sm" type="submit">
          찾기
        </Button>
        {filter && (
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => (setFilter(null), setText(''), setPage(0))}>
            지우기
          </Button>
        )}
      </form>

      {error ? (
        <div className="p-4">
          <ErrorBox error={error} onRetry={reload} />
        </div>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className={cx('max-h-[62vh] overflow-auto transition-opacity', loading && 'opacity-60')}>
            <table className="min-w-full text-[12.5px]">
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr>
                  {cols.map((c) => (
                    <th key={c.name} className="border-b border-line px-3 py-2 text-left align-bottom font-medium">
                      <button type="button" onClick={() => sortBy(c.name)} className="flex items-center gap-1 whitespace-nowrap hover:text-accent-2 cursor-pointer" title={`${c.columnType}${c.nullable ? ' · NULL 가능' : ''} · 눌러서 정렬`}>
                        {c.key === 'PRI' && <KeyRound size={12} className="text-warn" />}
                        <span className="mono">{c.name}</span>
                        {order?.col === c.name && (order.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      </button>
                      <div className="mt-0.5 whitespace-nowrap text-[11px] font-normal text-muted">{c.columnType}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={cols.length} className="px-4 py-8 text-center text-sm text-muted">
                      {filter ? '찾는 값이 있는 행이 없습니다' : '행이 없습니다'}
                    </td>
                  </tr>
                )}
                {data.rows.map((r, i) => (
                  <tr key={i} onClick={() => setDetail(r)} className="cursor-pointer hover:bg-surface-2">
                    {r.map((v, j) => (
                      <td key={j} className="mono max-w-[320px] truncate whitespace-nowrap px-3 py-1.5" title={v ?? 'NULL'}>
                        {v === null ? <span className="text-muted/60">NULL</span> : v === '' ? <span className="text-muted/60">(빈 값)</span> : v.replace(/\n/g, ' ↵ ')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-muted">
            <span>{data.rows.length ? `${from.toLocaleString()}–${to.toLocaleString()}번째 행` : ''}</span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} />} disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                이전
              </Button>
              <span className="px-1">{page + 1}쪽</span>
              <Button size="sm" variant="ghost" disabled={!data.hasMore || loading} onClick={() => setPage((p) => p + 1)}>
                다음 <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`${table} 행 보기`} width={640}>
        <div className="space-y-3">
          {detail &&
            cols.map((c, j) => (
              <div key={c.name}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs">
                    <span className="mono font-medium text-fg">{c.name}</span> <span className="text-muted">{c.columnType}</span>
                  </span>
                  {detail[j] !== null && <CopyButton text={detail[j]!} />}
                </div>
                <div className="mono max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-fill px-3 py-2 text-[12.5px]">
                  {detail[j] === null ? <span className="text-muted/60">NULL</span> : detail[j] || <span className="text-muted/60">(빈 값)</span>}
                </div>
              </div>
            ))}
          <p className="text-xs text-muted">긴 글은 앞 300자, 바이너리는 앞 32바이트만 보여 줍니다. 전체 값은 SQL 콘솔에서 확인하세요.</p>
        </div>
      </Modal>
    </div>
  );
}
