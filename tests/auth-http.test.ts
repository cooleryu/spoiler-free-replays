import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayServer } from '../server/index';

const PORT = 44321;
const ORIGIN = `http://127.0.0.1:${PORT}`;

test('web login routes are local, bounded, private, and independent of the catalog lock', async t => {
  let loggedIn = false;
  let starts = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const fakeSecret = 'synthetic-session-secret';
  const sessionId = 'fixture-session';
  const qrImage = 'data:image/gif;base64,R0lGODlh';
  const segment = { bvid: 'BV1P9pq63E1Y', cid: 42710992429, page: 1 };
  const app = await createReplayServer({ production: true, port: PORT,
    catalog: {
      get: async () => { entered(); await wait; return { status: 'ready', sourceName: 'fixture', matches: [], updatedAt: null, stale: false }; },
      refresh: async () => ({ status: 'ready', sourceName: 'fixture', matches: [], updatedAt: null, stale: false }),
      watch: async () => [segment],
    },
    auth: {
      status: () => ({ loggedIn, rawSecret: fakeSecret }),
      headers: (): Record<string, string> => loggedIn ? { Cookie: fakeSecret } : {},
      start: async () => { starts++; return { sessionId, qrImage, expiresAt: 123456789, rawSecret: fakeSecret }; },
      poll: async id => { assert.equal(id, sessionId); loggedIn = true; return { status: 'ready', rawSecret: fakeSecret }; },
      cancel: id => { assert.equal(id, sessionId); },
      logout: () => { loggedIn = false; },
      close: () => { loggedIn = false; },
    },
    playback: async (_segment, _signal, dependencies) => {
      assert.deepEqual(dependencies?.headers, loggedIn ? { Cookie: fakeSecret } : {});
      return { url: 'https://fixture.bilivideo.com/video.mp4' };
    },
  });
  t.after(() => { release(); return app.close(); });
  await app.listen();
  const post = (route: string, body: unknown, origin = ORIGIN) => fetch(`${ORIGIN}${route}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const route of ['/api/auth/start', '/api/auth/poll', '/api/auth/cancel', '/api/auth/logout']) {
    assert.equal((await post(route, {}, 'https://evil.example')).status, 403);
    assert.equal((await post(route, { Cookie: fakeSecret })).status, 400);
    assert.equal((await fetch(`${ORIGIN}${route}`)).status, 404);
  }
  assert.equal(starts, 0);
  assert.deepEqual(await (await fetch(`${ORIGIN}/api/auth/status`)).json(), { loggedIn: false });
  const pendingCatalog = fetch(`${ORIGIN}/api/matches`);
  await started;
  try {
    const response = await post('/api/auth/start', {});
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { sessionId, qrImage, expiresAt: 123456789 });
    assert.deepEqual(await (await post('/api/auth/poll', { sessionId })).json(), { status: 'ready' });
    assert.deepEqual(await (await fetch(`${ORIGIN}/api/auth/status`)).json(), { loggedIn: true });
  } finally { release(); await pendingCatalog; }
  const source = await post('/api/playback', segment);
  assert.deepEqual(await source.json(), { status: 'ready', url: 'https://fixture.bilivideo.com/video.mp4' });
  assert.deepEqual(await (await post('/api/auth/logout', {})).json(), { status: 'ok' });
  assert.deepEqual(await (await fetch(`${ORIGIN}/api/auth/status`)).json(), { loggedIn: false });
  assert.equal((await post('/api/playback', segment)).status, 200);
});
