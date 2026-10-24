import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * 빌드된 웹 UI 를 내보낸다.
 * assets/* 는 빌드마다 파일 이름이 바뀌므로 오래 캐시하고, index.html 은 캐시하지 않는다.
 * (index.html 을 캐시하면 hrone update 뒤에도 브라우저가 한동안 예전 화면을 보여 준다)
 */
export async function registerWeb(server: FastifyInstance, dist: string) {
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    await server.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      // '/' 는 아래 notFound 처리로 넘겨 항상 no-cache 로 보낸다
      index: false,
      maxAge: '1h',
      setHeaders: (reply, file) => {
        const rel = path.relative(dist, file).split(path.sep);
        if (rel[0] === 'assets') reply.header('cache-control', 'public, max-age=31536000, immutable');
        else if (rel[rel.length - 1] === 'index.html') reply.header('cache-control', 'no-cache');
      },
    });
  }
  server.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '없는 API 입니다' });
    const index = path.join(dist, 'index.html');
    if (!fs.existsSync(index)) return reply.code(503).type('text/plain; charset=utf-8').send('웹 UI 가 빌드되지 않았습니다 (npm run build)');
    return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(fs.readFileSync(index));
  });
}
