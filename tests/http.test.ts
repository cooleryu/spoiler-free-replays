import assert from 'node:assert/strict';
import { request, type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { ReplayError, type Segment } from '../server/domain';
import { allowedRequest, readJson } from '../server/http';
import { createReplayServer } from '../server/index';
import type { CatalogResult, MatchCatalog } from '../server/catalog';

const PORT = 44319;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MATCH_ID = 'BV1xx411c7mD';
const WATCH_INPUT = { matchId: MATCH_ID };
const SEGMENTS: Segment[] = [{ bvid: MATCH_ID, cid: 101, page: 1 }];
const CATALOG: CatalogResult = {
  status: 'ready', sourceName: 'Synthetic fixture source', updatedAt: '2026-10-14T08:30:00Z', stale: false,
  matches: [{ id: MATCH_ID, date: '2026-10-13', event: 'Fixture event', home: 'A', away: 'B' }],
};
const INVALID = { status: 'error', code: 'INVALID_INPUT' };
type CatalogApi = Pick<MatchCatalog, 'get' | 'refresh' | 'watch'>;
type Operation = keyof CatalogApi;
const OPERATIONS: Operation[] = ['get', 'refresh', 'watch'];
const ROUTES: Record<Operation, string> = { get: '/api/matches', refresh: '/api/matches/refresh', watch: '/api/watch' };

function message(headers: IncomingHttpHeaders, chunks: string[] = []): IncomingMessage {
  return Object.assign(Readable.from(chunks.map(value => Buffer.from(value))), { headers }) as unknown as IncomingMessage;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('request whitelist permits only the configured loopback hosts and matching mutation origins', () => {
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
    assert.equal(allowedRequest(message({ host }), PORT), true);
    assert.equal(allowedRequest(message({ host, origin: `http://${host}` }), PORT, true), true);
    assert.equal(allowedRequest(message({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), PORT, true), true);
  }
  for (const headers of [
    {}, { host: 'evil.example' }, { host: `127.0.0.1:${PORT + 1}` },
    { host: `127.0.0.1.evil.example:${PORT}` }, { host: `[::1]:${PORT}` },
    { host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' },
    { host: `127.0.0.1:${PORT}`, origin: 'null' },
    { host: `127.0.0.1:${PORT}`, origin: `https://127.0.0.1:${PORT}` },
    { host: `127.0.0.1:${PORT}`, origin: `http://localhost:${PORT}` },
  ]) assert.equal(allowedRequest(message(headers), PORT), false);
  assert.equal(allowedRequest(message({ host: `127.0.0.1:${PORT}` }), PORT, true), false);
  assert.equal(allowedRequest(message({ host: `127.0.0.1:${PORT}`, origin: ORIGIN, 'sec-fetch-site': 'cross-site' }), PORT, true), false);
});

test('JSON reader accepts a bounded application/json body split across chunks', async () => {
  assert.deepEqual(await readJson(message({ 'content-type': 'application/json; charset=utf-8' }, ['{"matchId":', `"${MATCH_ID}"}`])), WATCH_INPUT);
});

test('JSON reader rejects non-JSON, malformed bodies and both declared and streamed byte overflows', async () => {
  const invalid = [
    message({}, ['{}']),
    message({ 'content-type': 'text/plain' }, ['{}']),
    message({ 'content-type': 'application/json' }, ['{']),
    message({ 'content-type': 'application/json' }, []),
    message({ 'content-type': 'application/json', 'content-length': '4097' }, ['{}']),
    message({ 'content-type': 'application/json' }, ['"', 'x'.repeat(4096), '"']),
    message({ 'content-type': 'application/json' }, ['"', '测'.repeat(1500), '"']),
  ];
  for (const req of invalid) {
    await assert.rejects(readJson(req), (error: unknown) => error instanceof ReplayError && error.code === 'INVALID_INPUT');
  }
});

// Real loopback HTTP with an injected offline catalog; no Bilibili or search requests occur.
test('catalog HTTP routes enforce request boundaries, privacy, exclusivity and cancellation', { timeout: 20000 }, async t => {
  const calls: Record<Operation, number> = { get: 0, refresh: 0, watch: 0 };
  const defaults = (): CatalogApi => ({ get: async () => CATALOG, refresh: async () => CATALOG, watch: async () => SEGMENTS });
  let implementations = defaults();
  const app = await createReplayServer({
    production: true, port: PORT,
    catalog: {
      get: async signal => { calls.get++; return implementations.get(signal); },
      refresh: async signal => { calls.refresh++; return implementations.refresh(signal); },
      watch: async (id, signal) => { calls.watch++; return implementations.watch(id, signal); },
    },
  });
  let closing: Promise<void> | undefined;
  const closeApp = () => closing ??= app.close();
  t.after(closeApp);
  await app.listen();

  const callApi = (operation: Operation, signal?: AbortSignal) => fetch(`${ORIGIN}${ROUTES[operation]}`, {
    ...(operation === 'get' ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(operation === 'watch' ? WATCH_INPUT : {}),
    }), signal,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${ORIGIN}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body),
  });
  const rawRequest = (path: string, method: string, headers: Record<string, string>, body = '') => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = request(`${ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(body);
  });
  const intercept = (operation: Operation, action: (signal: AbortSignal) => Promise<void>) => {
    if (operation === 'watch') implementations.watch = async (_id, signal) => { await action(signal); return SEGMENTS; };
    else implementations[operation] = async signal => { await action(signal); return CATALOG; };
  };

  await t.test('foreign origins and hosts cannot reach any catalog endpoint; mutations also require an origin', async () => {
    const before = { ...calls };
    for (const operation of OPERATIONS) {
      const method = operation === 'get' ? 'GET' : 'POST';
      const deniedHeaders: Record<string, string>[] = [
        { origin: 'https://evil.example' }, { origin: ORIGIN, host: `evil.example:${PORT}` },
      ];
      if (operation !== 'get') deniedHeaders.push({}, { origin: ORIGIN, 'sec-fetch-site': 'cross-site' });
      for (const headers of deniedHeaders) {
        const response = await rawRequest(ROUTES[operation], method, headers, operation === 'get' ? '' : '{}');
        assert.deepEqual(response, { status: 403, body: INVALID });
      }
    }
    assert.deepEqual(calls, before);
  });

  await t.test('watch accepts only one valid matchId and refresh accepts only an empty object', async () => {
    const before = { ...calls };
    const invalidWatch = [
      {}, { matchId: '' }, { matchId: 'not-a-bvid' }, { matchId: `https://www.bilibili.com/video/${MATCH_ID}` },
      { matchId: 1 }, { ...WATCH_INPUT, command: 'not accepted' },
      { mode: 'import', input: MATCH_ID }, { matchId: 'x'.repeat(5000) }, null, [], 'fixture',
    ];
    const invalidRefresh = [{ source: 'arbitrary-account' }, { command: 'not accepted' }, WATCH_INPUT, null, [], '', 1];
    for (const [path, bodies] of [[ROUTES.watch, invalidWatch], [ROUTES.refresh, invalidRefresh]] as const) {
      for (const body of bodies) {
        const response = await post(path, body);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), INVALID);
      }
    }
    assert.deepEqual(calls, before);
  });

  await t.test('malformed JSON, absent bodies, non-JSON types and byte overflows fail before catalog work', async () => {
    const before = { ...calls };
    for (const path of [ROUTES.watch, ROUTES.refresh]) {
      for (const [headers, body] of [
        [{ origin: ORIGIN }, '{'], [{ origin: ORIGIN }, ''],
        [{ origin: ORIGIN, 'content-type': 'text/plain' }, '{}'],
        [{ origin: ORIGIN }, `{"padding":"${'x'.repeat(5000)}"}`],
      ] as const) {
        assert.deepEqual(await rawRequest(path, 'POST', headers, body), { status: 400, body: INVALID });
      }
    }
    assert.deepEqual(calls, before);
  });

  await t.test('retired prepare, unknown API paths, query variants and wrong methods return 404 without catalog work', async () => {
    const before = { ...calls };
    for (const [path, method] of [
      ['/api/prepare', 'POST'], ['/api/unknown', 'GET'], ['/api/matches?source=other', 'GET'],
      ['/api/matches', 'POST'], ['/api/matches/refresh', 'GET'], ['/api/watch', 'GET'], ['/api/watch', 'PUT'],
    ]) {
      const response = await rawRequest(path, method, { origin: ORIGIN }, method === 'GET' ? '' : '{}');
      assert.deepEqual(response, { status: 404, body: INVALID });
    }
    assert.deepEqual(calls, before);
  });

  await t.test('GET and refresh return the catalog result, while watch receives the selected identifier and returns segments', async () => {
    const before = { ...calls };
    const refreshed: CatalogResult = { ...CATALOG, stale: true, warning: 'RATE_LIMITED' };
    implementations = {
      get: async signal => { assert.equal(signal.aborted, false); return CATALOG; },
      refresh: async signal => { assert.equal(signal.aborted, false); return refreshed; },
      watch: async (id, signal) => { assert.equal(id, MATCH_ID); assert.equal(signal.aborted, false); return SEGMENTS; },
    };
    for (const operation of OPERATIONS) {
      const response = await callApi(operation);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.match(response.headers.get('content-security-policy') ?? '', /frame-src 'none'/);
      assert.match(response.headers.get('content-security-policy') ?? '', /media-src https:\/\/\*\.bilivideo\.com/);
      assert.deepEqual(await response.json(), operation === 'watch' ? { status: 'ready', segments: SEGMENTS } : operation === 'refresh' ? refreshed : CATALOG);
    }
    assert.deepEqual(calls, { get: before.get + 1, refresh: before.refresh + 1, watch: before.watch + 1 });
  });

  await t.test('known and unexpected failures never expose raw messages or synthetic secrets on any endpoint', async () => {
    const secret = 'synthetic-only-secret-never-a-user-credential';
    for (const operation of OPERATIONS) {
      for (const [error, code] of [
        [Object.assign(new ReplayError('SOURCE_UNAVAILABLE'), { message: `Fixture Cookie=${secret}; title=A 3:0 B` }), 'SOURCE_UNAVAILABLE'],
        [Object.assign(new ReplayError('RATE_LIMITED'), { message: `Fixture ${secret}` }), 'RATE_LIMITED'],
        [Object.assign(new ReplayError('MATCH_UNAVAILABLE'), { message: `Fixture ${secret}` }), 'MATCH_UNAVAILABLE'],
        [new Error(`Fixture authorization Bearer ${secret}; raw upstream title`), 'INTERNAL'],
      ] as const) {
        implementations = defaults();
        intercept(operation, async () => { throw error; });
        const response = await callApi(operation);
        const text = await response.text();
        assert.equal(response.status, 422);
        assert.deepEqual(JSON.parse(text), { status: 'error', code });
        assert.equal(text.includes(secret), false);
        assert.doesNotMatch(text, /Cookie|Bearer|title|stack|3:0/);
      }
    }
  });

  await t.test('all three endpoints share one task lock and recover after each successful task', async () => {
    for (const activeOperation of OPERATIONS) {
      implementations = defaults();
      const started = deferred<void>();
      const completed = deferred<void>();
      intercept(activeOperation, async () => { started.resolve(); await completed.promise; });
      const before = { ...calls };
      const first = callApi(activeOperation);
      try {
        await started.promise;
        for (const blockedOperation of OPERATIONS) {
          const response = await callApi(blockedOperation);
          assert.equal(response.status, 409);
          assert.deepEqual(await response.json(), { status: 'error', code: 'BUSY' });
        }
        assert.deepEqual(calls, { ...before, [activeOperation]: before[activeOperation] + 1 });
      } finally { completed.resolve(); }
      const response = await first;
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), activeOperation === 'watch' ? { status: 'ready', segments: SEGMENTS } : CATALOG);
    }
  });

  await t.test('aborting any endpoint cancels its work and retains the lock until cleanup finishes', async () => {
    for (const operation of OPERATIONS) {
      implementations = defaults();
      const started = deferred<void>();
      const cancelled = deferred<unknown>();
      const cleanup = deferred<void>();
      const cleanupDone = deferred<void>();
      let cleaned = false;
      intercept(operation, async signal => {
        try {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => { cancelled.resolve(signal.reason); reject(new ReplayError('CANCELLED')); }, { once: true });
            started.resolve();
          });
        } finally { await cleanup.promise; cleaned = true; cleanupDone.resolve(); }
      });
      const controller = new AbortController();
      const abortedFetch = assert.rejects(callApi(operation, controller.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
      try {
        await started.promise;
        controller.abort();
        await abortedFetch;
        assert.equal(await cancelled.promise, 'CANCELLED');
        assert.equal(cleaned, false);
        const stillBusy = await callApi('get');
        assert.equal(stillBusy.status, 409);
        assert.deepEqual(await stillBusy.json(), { status: 'error', code: 'BUSY' });
      } finally { controller.abort(); cleanup.resolve(); await abortedFetch; }
      await cleanupDone.promise;
      await nextTick();
      assert.equal(cleaned, true);
      implementations = defaults();
      const recovered = await callApi('get');
      assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), CATALOG);
    }
  });

  await t.test('server shutdown cancels active work and awaits its cleanup', async () => {
    const started = deferred<void>();
    const cancelled = deferred<unknown>();
    const cleanup = deferred<void>();
    let cleaned = false;
    intercept('refresh', async signal => {
      try {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { cancelled.resolve(signal.reason); reject(new ReplayError('CANCELLED')); }, { once: true });
          started.resolve();
        });
      } finally { await cleanup.promise; cleaned = true; }
    });
    const disconnected = assert.rejects(callApi('refresh'), (error: unknown) => error instanceof Error);
    try {
      await started.promise;
      let closed = false;
      const stopped = closeApp().then(() => { closed = true; });
      assert.equal(await cancelled.promise, 'CANCELLED');
      await nextTick();
      assert.equal(closed, false);
      assert.equal(cleaned, false);
      cleanup.resolve();
      await stopped;
      await disconnected;
      assert.equal(cleaned, true);
    } finally { cleanup.resolve(); await disconnected; }
  });
});
