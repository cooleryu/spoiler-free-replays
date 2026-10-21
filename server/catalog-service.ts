import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchCatalog, type PublicSnapshot } from './catalog';
import { errorCode } from './domain';

/** Public, read-only directory. Authentication and video playback never run here. */
export function createCatalogService() {
  const port = Number(process.env.CATALOG_PORT || 4320);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid catalog port');
  const catalog = new MatchCatalog({ catalogUrl: null, cacheFile: process.env.CATALOG_CACHE_FILE });
  let cached: PublicSnapshot | undefined;
  let pending: Promise<PublicSnapshot> | undefined;
  let nextAttempt = 0;
  const shutdown = new AbortController();

  async function directory(): Promise<PublicSnapshot> {
    if (cached && Date.now() < nextAttempt) return cached;
    if (pending) return pending;
    if (Date.now() < nextAttempt) throw new Error('Directory temporarily unavailable');
    nextAttempt = Date.now() + 30_000;
    pending = (async () => {
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(20_000)]);
      const result = await catalog.refresh(signal);
      const snapshot = catalog.publicSnapshot(result);
      cached = snapshot;
      nextAttempt = Date.now() + (result.warning ? 30_000 : 5 * 60_000);
      return snapshot;
    })();
    try { return await pending; } finally { pending = undefined; }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url !== '/replays/catalog.json' || !['GET', 'HEAD'].includes(req.method ?? '')) {
      res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); return;
    }
    try {
      const data = await directory();
      if (res.destroyed) return;
      res.setHeader('Cache-Control', 'public, max-age=30');
      res.writeHead(200);
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
    } catch (error) {
      if (res.destroyed) return;
      res.writeHead(503, { 'Retry-After': '30' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: errorCode(error) }));
    }
  });
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 30;
  server.maxConnections = 128;
  return {
    listen: () => new Promise<void>((done, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', done);
    }),
    close: async () => {
      shutdown.abort(); server.closeAllConnections();
      await pending?.catch(() => {});
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createCatalogService();
  await app.listen();
  console.log('Public match directory started');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}
