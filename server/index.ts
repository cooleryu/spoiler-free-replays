import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ViteDevServer } from 'vite';
import { z } from 'zod';
import { allowedRequest, json, readJson } from './http';
import { BVID, ReplayError, errorCode, segmentSchema } from './domain';
import { MatchCatalog } from './catalog';
import { resolvePlayback, ALLOWED_MEDIA_HOST_SUFFIXES } from './playback';
import { root } from './paths';
import { ReplayAuth } from './auth';
import { createMediaRelay } from './media-relay';
import sourceConfig from '../config/source.json';
import catalogService from '../config/catalog-service.json';

type AuthApi = Pick<ReplayAuth, 'status' | 'headers' | 'start' | 'poll' | 'cancel' | 'logout' | 'close'>;
const AUTH_ROUTES = new Map<string, 'start' | 'poll' | 'cancel' | 'logout'>([
  ['/api/auth/start', 'start'], ['/api/auth/poll', 'poll'],
  ['/api/auth/cancel', 'cancel'], ['/api/auth/logout', 'logout'],
]);

function configuredCatalogUrl(): string | null {
  // An explicit local override (including an empty value) takes priority over the bundled service.
  if (process.env.REPLAY_CATALOG_URL !== undefined) return process.env.REPLAY_CATALOG_URL.trim() || null;
  const fields = ['creatorMid', 'query', 'event', 'year', 'lookbackDays'] as const;
  return fields.every(field => sourceConfig[field] === catalogService.source[field]) ? catalogService.url : null;
}

export async function createReplayServer(options: { port?: number; production?: boolean; catalog?: Pick<MatchCatalog, 'get' | 'refresh' | 'watch'>; playback?: typeof resolvePlayback; auth?: AuthApi } = {}) {
  const port = options.port ?? Number(process.env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const timeoutMs = Math.min(60_000, Math.max(1000, Number(process.env.REPLAY_TIMEOUT_MS) || 45_000));
  let active: AbortController | undefined;
  let finishing: Promise<void> | undefined;
  let vite: ViteDevServer | undefined;
  const catalog = options.catalog ?? new MatchCatalog({ catalogUrl: configuredCatalogUrl() });
  const playback = options.playback ?? resolvePlayback;
  const auth = options.auth ?? new ReplayAuth();
  const mediaRelay = createMediaRelay();
  const authRequests = new Map<AbortController, Promise<void>>();
  const mediaSources = ALLOWED_MEDIA_HOST_SUFFIXES.map(suffix => `https://*${suffix}`).join(' ');
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', `default-src 'self'; frame-src 'none'; media-src ${mediaSources} blob:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' blob: ${mediaSources} ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    if (!allowedRequest(req, port, req.method !== 'GET' && req.method !== 'HEAD')) { json(res, 403, { status: 'error', code: 'INVALID_INPUT' }); return; }
    const mediaId = req.url?.match(/^\/api\/media\/([A-Za-z0-9_-]{32})$/)?.[1];
    if (mediaId) { await mediaRelay.serve(mediaId, req, res); return; }
    if (req.url === '/api/auth/status' && req.method === 'GET') {
      json(res, 200, { loggedIn: auth.status().loggedIn }); return;
    }
    const authOperation = req.method === 'POST' ? AUTH_ROUTES.get(req.url ?? '') : undefined;
    if (authOperation) {
      // Short QR requests use their own cancellation scope, so scanning never blocks playback.
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort('TIMEOUT'), 20_000);
      const cancel = () => { if (!res.writableEnded) controller.abort('CANCELLED'); };
      res.once('close', cancel);
      const work = (async () => {
        try {
          const raw = await readJson(req);
          let result: unknown;
          if (authOperation === 'start' || authOperation === 'logout') {
            if (!z.object({}).strict().safeParse(raw).success) throw new ReplayError('INVALID_INPUT');
            if (authOperation === 'logout') { auth.logout(); mediaRelay.clear(); result = { status: 'ok' }; }
            else {
              const login = await auth.start(controller.signal);
              result = { sessionId: login.sessionId, qrImage: login.qrImage, expiresAt: login.expiresAt };
            }
          } else {
            const body = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict().safeParse(raw);
            if (!body.success) throw new ReplayError('INVALID_INPUT');
            if (authOperation === 'cancel') { auth.cancel(body.data.sessionId); result = { status: 'ok' }; }
            else { const polled = await auth.poll(body.data.sessionId, controller.signal); if (polled.status === 'ready') mediaRelay.clear(); result = { status: polled.status }; }
          }
          if (controller.signal.aborted) throw new ReplayError(controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
          json(res, 200, result);
        } catch (error) {
          const code = controller.signal.aborted ? (controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED') : errorCode(error);
          json(res, code === 'INVALID_INPUT' ? 400 : 422, { status: 'error', code });
        } finally { clearTimeout(deadline); res.removeListener('close', cancel); }
      })();
      authRequests.set(controller, work);
      try { await work; } finally { authRequests.delete(controller); }
      return;
    }
    const catalogRoute = req.url?.match(/^\/api\/matches(\/refresh)?(?:\?source=official)?$/);
    const operation = catalogRoute && !catalogRoute[1] && req.method === 'GET' ? 'get'
      : catalogRoute?.[1] && req.method === 'POST' ? 'refresh'
      : req.url === '/api/watch' && req.method === 'POST' ? 'watch'
      : req.url === '/api/playback' && req.method === 'POST' ? 'playback' : null;
    if (operation) {
      if (active) { json(res, 409, { status: 'error', code: 'BUSY' }); return; }
      const controller = new AbortController(); active = controller;
      const deadline = setTimeout(() => controller.abort('TIMEOUT'), timeoutMs);
      const cancel = () => { if (!res.writableEnded) controller.abort('CANCELLED'); };
      res.once('close', cancel);
      finishing = (async () => {
        try {
          let result;
          if (operation === 'get') result = await catalog.get(controller.signal);
          else if (operation === 'refresh') {
            if (!z.object({}).strict().safeParse(await readJson(req)).success) throw new ReplayError('INVALID_INPUT');
            result = await catalog.refresh(controller.signal);
          } else if (operation === 'watch') {
            const body = z.object({ matchId: z.string().max(100).regex(BVID) }).strict().safeParse(await readJson(req));
            if (!body.success) throw new ReplayError('INVALID_INPUT');
            result = { status: 'ready', segments: await catalog.watch(body.data.matchId, controller.signal) };
          } else {
            const body = segmentSchema.extend({ quality: z.number().int().refine(value => [16, 32, 64, 74, 80, 112, 116, 120, 125, 126, 127].includes(value)).optional() }).strict().safeParse(await readJson(req));
            if (!body.success) throw new ReplayError('INVALID_INPUT');
            const verified = await catalog.watch(body.data.bvid, controller.signal);
            const selectedSegment = verified.find(segment => segment.bvid === body.data.bvid && segment.cid === body.data.cid
              && segment.page === body.data.page);
            if (!selectedSegment) throw new ReplayError('MATCH_UNAVAILABLE');
            const loggedIn = auth.status().loggedIn;
            if ((body.data.quality ?? 64) > 64 && !loggedIn) throw new ReplayError('BILIBILI_LOGIN');
            const source = await playback(selectedSegment, controller.signal,
              { headers: auth.headers(), loggedIn, quality: body.data.quality });
            // Only URLs already validated by resolvePlayback can be registered. Never accept a client-supplied address.
            const manifest = source.manifest?.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_match, encoded: string) => {
              const address = encoded.replace(/&(amp|quot|apos|lt|gt);/g, (_entity, name: string) =>
                ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name]!);
              const id = mediaRelay.register(address);
              return `<BaseURL>http://${req.headers.host}/api/media/${id}</BaseURL>`;
            });
            result = { status: 'ready', ...(source.url ? { url: source.url } : {}),
              ...(manifest ? { manifest } : {}),
              ...(source.quality !== undefined ? { quality: source.quality } : {}),
              ...(source.qualities ? { qualities: source.qualities.map(({ quality, label, available, requiresLogin, requiresVip }) =>
                ({ quality, label, available, requiresLogin, requiresVip })) } : {}) };
          }
          if (controller.signal.aborted) throw new ReplayError(controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
          json(res, 200, result);
        } catch (e) {
          const code = controller.signal.aborted
            ? (controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED') : errorCode(e);
          json(res, code === 'INVALID_INPUT' ? 400 : 422, { status: 'error', code });
        } finally {
          clearTimeout(deadline); res.removeListener('close', cancel);
          if (active === controller) active = undefined;
        }
      })();
      await finishing; return;
    }
    if (req.url?.startsWith('/api/')) { json(res, 404, { status: 'error', code: 'INVALID_INPUT' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (vite) { vite.middlewares(req, res); return; }
    if (options.production) {
      try {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== '/' && !/^\/assets\/[a-zA-Z0-9._-]+$/.test(pathname)) { res.writeHead(404).end(); return; }
        const file = resolve(root, 'dist', pathname === '/' ? 'index.html' : pathname.slice(1));
        const content = await readFile(file);
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : content);
      } catch { res.writeHead(404).end(); }
      return;
    }
    res.writeHead(503).end();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  if (!options.production) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({ root, server: { middlewareMode: true, ws: { server },
      fs: { strict: true, allow: [root], deny: ['**/.local/**', '**/.env*', '**/.git/**', '**/server/**', '**/scripts/**', '**/config/**', '**/tests/**'] } }, appType: 'spa' });
  }
  return {
    server,
    listen: () => new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); }),
    close: async () => {
      auth.close();
      mediaRelay.close();
      for (const controller of authRequests.keys()) controller.abort('CANCELLED');
      active?.abort('CANCELLED'); server.closeAllConnections();
      await Promise.allSettled(authRequests.values());
      await finishing; await vite?.close();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createReplayServer({ production: process.argv.includes('--production') });
  await app.listen();
  console.log(`比赛回放已启动：http://127.0.0.1:${process.env.PORT || 4318}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
  process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
}
