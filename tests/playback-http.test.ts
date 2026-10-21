import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayServer } from '../server/index';
import { ReplayError, type Segment } from '../server/domain';

const PORT = 44320;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const segment: Segment = { bvid: 'BV1P9pq63E1Y', cid: 42710992429, page: 1 };
const qualities = [{ quality: 64, label: '720P 准高清', available: true, requiresLogin: false, requiresVip: false }];
const safeUrl = 'https://fixture.bilivideo.com/video.mp4?deadline=1234567890';

test('playback HTTP resolves only an exact current catalog segment without exposing upstream metadata', async t => {
  let sourceCalls = 0;
  let allowed = true;
  let sourceError: unknown;
  let sourceManifest: string | undefined;
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
    if (sourceManifest) return { manifest: sourceManifest, quality: 64, qualities };
    return { url: safeUrl, quality: 64, qualities, rawTitle: 'Fixture secret 3:0', duration: 123 };
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
  await t.test('high quality requires this local login and malformed quality never reaches the source', async () => {
    const locked = await post({ ...segment, quality: 80 });
    assert.equal(locked.status, 422);
    assert.deepEqual(await locked.json(), { status: 'error', code: 'BILIBILI_LOGIN' });
    for (const quality of [0, 999, '80', null, 64.5]) assert.equal((await post({ ...segment, quality })).status, 400);
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
  await t.test('a verified source returns only playback fields, uncached with restricted media CSP', async () => {
    const response = await post(segment);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready', url: safeUrl, quality: 64, qualities });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy') ?? '', /media-src https:\/\/\*\.bilivideo\.com https:\/\/\*\.bilivideo\.cn blob:;/);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-src 'none'/);
    assert.equal(sourceCalls, 1);
  });
  await t.test('DASH sources become local opaque routes with range and origin enforcement', async () => {
    sourceManifest = '<MPD type="static"><Period><AdaptationSet contentType="video"><Representation id="64"><BaseURL>https://fixture.bilivideo.com/video.m4s?deadline=1234567890&amp;token=fixture</BaseURL></Representation></AdaptationSet></Period></MPD>';
    try {
      const response = await post(segment);
      assert.equal(response.status, 200);
      const body = await response.json() as { status: string; manifest: string; url?: string };
      assert.equal(body.status, 'ready'); assert.equal(body.url, undefined);
      const address = body.manifest.match(/<BaseURL>([^<]+)<\/BaseURL>/)?.[1];
      assert.ok(address);
      const local = new URL(address);
      assert.equal(local.origin, ORIGIN);
      assert.match(local.pathname, /^\/api\/media\/[A-Za-z0-9_-]{32}$/);
      assert.equal(local.search, '');
      assert.doesNotMatch(body.manifest, /bilivideo|deadline=|token=fixture/);
      // These refusals happen before fetching any upstream media.
      assert.equal((await fetch(address)).status, 416);
      assert.equal((await fetch(`${ORIGIN}/api/media/${'a'.repeat(32)}`)).status, 404);
      assert.equal((await fetch(address, { headers: { origin: 'https://evil.example' } })).status, 403);
    } finally { sourceManifest = undefined; }
  });
  await t.test('source errors do not leak signed addresses or source details', async () => {
    sourceError = new Error(`Cannot fetch ${safeUrl}`);
    const response = await post(segment);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { status: 'error', code: 'INTERNAL' });
  });
});
