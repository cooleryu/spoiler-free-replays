import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayServer } from '../server/index';
import { ReplayError, type Segment } from '../server/domain';

const PORT = 44320;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const segment: Segment = { bvid: 'BV1P9pq63E1Y', cid: 42710992429, page: 1 };
const safeUrl = 'https://fixture.bilivideo.com/video.mp4?deadline=1234567890';

test('playback HTTP resolves only an exact current catalog segment without exposing upstream metadata', async t => {
  let sourceCalls = 0;
  let allowed = true;
  let sourceError: unknown;
  const app = await createReplayServer({ production: true, port: PORT, catalog: {
    get: async () => ({ status: 'ready', sourceName: 'Fixture', updatedAt: null, stale: false, matches: [] }),
    refresh: async () => ({ status: 'ready', sourceName: 'Fixture', updatedAt: null, stale: false, matches: [] }),
    watch: async (id, signal) => {
      assert.equal(signal.aborted, false);
      if (!allowed || id !== segment.bvid) throw new ReplayError('MATCH_UNAVAILABLE');
      return [segment];
    },
  }, playback: async (input, signal) => {
    sourceCalls++;
    assert.deepEqual(input, segment);
    assert.equal(signal.aborted, false);
    if (sourceError) throw sourceError;
    return { url: safeUrl, rawTitle: 'Fixture secret 3:0', duration: 123 };
  } });
  t.after(() => app.close());
  await app.listen();
  const post = (body: unknown, origin = ORIGIN) => fetch(`${ORIGIN}/api/playback`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await t.test('foreign origins and malformed or extra playback identities never resolve a source', async () => {
    assert.equal((await post(segment, 'https://evil.example')).status, 403);
    for (const body of [{}, null, { ...segment, cid: -1 }, { ...segment, page: 0 }, { ...segment, url: safeUrl }, { ...segment, bvid: 'https://example.com' }]) {
      const response = await post(body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { status: 'error', code: 'INVALID_INPUT' });
    }
    assert.equal(sourceCalls, 0);
  });
  await t.test('an unknown BV, mismatched CID, wrong P, or expired list entry cannot resolve media', async () => {
    for (const body of [{ ...segment, bvid: 'BV1JuWA6TEvg' }, { ...segment, cid: 42714597414 }, { ...segment, page: 2 }]) {
      const response = await post(body);
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), { status: 'error', code: 'MATCH_UNAVAILABLE' });
    }
    allowed = false;
    assert.equal((await post(segment)).status, 422);
    allowed = true;
    assert.equal(sourceCalls, 0);
  });
  await t.test('a verified source returns only status and the temporary URL, uncached with restricted media CSP', async () => {
    const response = await post(segment);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready', url: safeUrl });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy') ?? '', /media-src https:\/\/\*\.bilivideo\.com;/);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-src 'none'/);
    assert.equal(sourceCalls, 1);
  });
  await t.test('source errors do not leak signed addresses or source details', async () => {
    sourceError = new Error(`Cannot fetch ${safeUrl}`);
    const response = await post(segment);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { status: 'error', code: 'INTERNAL' });
  });
});
