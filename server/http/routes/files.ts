import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from '../../lib/util.ts';
import { attachmentHeader, createFile, listDir, readPreview, resolveInside, tarStream, writeText, type Owner } from '../../services/files.ts';

type Query = { path?: string; deps?: string };

/**
 * 파일 탐색 API (기본은 읽기 전용).
 *   GET {base}?path=          폴더 목록
 *   GET {base}/content?path=  파일 미리보기 (1MB 까지)
 *   GET {base}/download?path= 파일 그대로, 폴더는 tar.gz (deps=1 이면 node_modules 등도 포함)
 * write 를 주면 고치기도 된다:
 *   PUT  {base}/content  { path, text, mtime }  저장 (mtime 이 다르면 409)
 *   POST {base}/create   { dir, name }          빈 파일 만들기
 */
export function registerFileRoutes(
  server: FastifyInstance,
  base: string,
  opts: {
    root: (req: FastifyRequest) => string;
    onDownload?: (req: FastifyRequest, rel: string) => void;
    write?: {
      /** 새 파일의 소유자 (앱 계정) */
      owner: (req: FastifyRequest) => Owner;
      /** 지금 고치면 안 되는 상황(배포 중 등)이면 던진다 */
      guard?: (req: FastifyRequest) => void;
      onWrite?: (req: FastifyRequest, rel: string, kind: 'edit' | 'create') => void;
    };
  },
) {
  const rootOf = (req: FastifyRequest) => {
    const root = opts.root(req);
    if (!fs.existsSync(root)) throw new HttpError(404, '아직 받아 온 파일이 없습니다. 첫 배포가 끝나면 보입니다.');
    return root;
  };
  const query = (req: FastifyRequest) => (req.query ?? {}) as Query;

  server.get(base, async (req) => listDir(rootOf(req), query(req).path ?? ''));

  server.get(`${base}/content`, async (req) => readPreview(rootOf(req), query(req).path ?? ''));

  server.get(`${base}/download`, async (req, reply) => {
    const { abs, rel } = resolveInside(rootOf(req), query(req).path ?? '');
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      opts.onDownload?.(req, rel || '/');
      const { stream, kill } = tarStream(abs, { skipDeps: query(req).deps !== '1' });
      // 받는 쪽이 중간에 끊으면 tar 도 멈춘다 (정상 종료 뒤 부르는 것은 무해)
      reply.raw.on('close', kill);
      reply.header('content-disposition', attachmentHeader(`${path.basename(abs)}.tar.gz`)).type('application/gzip');
      return reply.send(stream);
    }
    if (!st.isFile()) throw new HttpError(400, '내려받을 수 없는 종류입니다');
    opts.onDownload?.(req, rel);
    reply.header('content-disposition', attachmentHeader(path.basename(abs))).header('content-length', st.size).type('application/octet-stream');
    return reply.send(fs.createReadStream(abs));
  });

  const w = opts.write;
  if (!w) return;
  type Body = { path?: string; text?: unknown; mtime?: unknown; dir?: string; name?: string };

  server.put(`${base}/content`, async (req) => {
    const b = (req.body ?? {}) as Body;
    if (typeof b.text !== 'string') throw new HttpError(400, '내용이 없습니다');
    w.guard?.(req);
    const r = writeText(rootOf(req), String(b.path ?? ''), b.text, { mtime: typeof b.mtime === 'number' ? b.mtime : undefined });
    w.onWrite?.(req, r.path, 'edit');
    return r;
  });

  server.post(`${base}/create`, async (req) => {
    const b = (req.body ?? {}) as Body;
    w.guard?.(req);
    const r = createFile(rootOf(req), String(b.dir ?? ''), String(b.name ?? '').trim(), w.owner(req));
    w.onWrite?.(req, r.path, 'create');
    return r;
  });
}
