import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_MEDIA_HOST_SUFFIXES, parsePlayback, resolvePlayback, type PlaybackDependencies,
} from '../server/playback';
import { ReplayError, type ErrorCode, type Segment } from '../server/domain';

const segment: Segment = { bvid: 'BV1P9pq63E1Y', cid: 42710992429, page: 1 };
const mediaUrl = 'https://cn-fjqz-cm-01-01.bilivideo.com/upgcxcode/fixture/1-1-16.mp4?deadline=1799999999&sign=offline-fixture';
const signal = () => new AbortController().signal;
const code = (expected: ErrorCode) => (error: unknown) => error instanceof ReplayError && error.code === expected;
type Fetch = NonNullable<PlaybackDependencies['fetch']>;

// The anonymous probe's response shape, with a synthetic signed location. No media is fetched here.
function upstream(overrides: Record<string, unknown> = {}) {
  return {
    format: 'mp4', quality: 16, timelength: 3795054, accept_quality: [116, 80, 64, 32, 16],
    durl: [{ order: 1, length: 3795054, size: 270412875, url: mediaUrl }],
    title: 'Fixture spoiler', stat: { view: 12345 }, ...overrides,
  };
}

test('a single declared progressive MP4 exposes only its validated location', () => {
  const raw = upstream();
  const copy = structuredClone(raw);
  assert.deepEqual(parsePlayback(raw), { url: mediaUrl });
  assert.deepEqual(raw, copy);
  assert.deepEqual(Object.keys(parsePlayback(raw)), ['url']);
  assert.doesNotMatch(JSON.stringify(parsePlayback(raw)), /timelength|duration|quality|Fixture|stat|size|length/);
});

test('CSP host suffixes stay limited to the observed progressive MP4 CDN family', () => {
  assert.deepEqual(ALLOWED_MEDIA_HOST_SUFFIXES, ['.bilivideo.com']);
  assert.deepEqual(parsePlayback(upstream({ durl: [{ order: 1, url: 'https://other-cdn.bilivideo.com:443/movie.mp4' }] })),
    { url: 'https://other-cdn.bilivideo.com/movie.mp4' });
});

test('multiple fragments, missing identity, DASH, and undeclared formats cannot masquerade as one MP4', () => {
  const validPart = { order: 1, url: mediaUrl };
  for (const raw of [
    null, undefined, [], {}, { durl: [validPart] },
    upstream({ format: 'flv' }), upstream({ format: 'dash' }), upstream({ format: 'MP4' }),
    upstream({ durl: [] }), upstream({ durl: [validPart, { ...validPart, order: 2 }] }),
    upstream({ durl: [{ url: mediaUrl }] }), upstream({ durl: [{ ...validPart, order: 2 }] }),
    upstream({ durl: [{ ...validPart, order: '1' }] }),
    upstream({ dash: { video: [], audio: [] } }), upstream({ durl: null }),
    { code: 0, data: upstream() },
  ]) assert.throws(() => parsePlayback(raw), code('MATCH_UNAVAILABLE'));
});

test('media URLs reject non-HTTPS protocols, credentials, fragments, and nonstandard ports', () => {
  for (const url of [
    'http://cdn.bilivideo.com/video.mp4', '//cdn.bilivideo.com/video.mp4',
    'file:///tmp/video.mp4', 'data:video/mp4;base64,AAAA', 'javascript:alert(1)',
    'ftp://cdn.bilivideo.com/video.mp4', 'https://cdn.bilivideo.com:8082/video.mp4',
    'https://cdn.bilivideo.com:80/video.mp4', 'https://user@cdn.bilivideo.com/video.mp4',
    'https://user:password@cdn.bilivideo.com/video.mp4', 'https://@cdn.bilivideo.com/video.mp4',
    'https://cdn.bilivideo.com/video.mp4#t=60', 'https://cdn.bilivideo.com/video.mp4#',
    ' https://cdn.bilivideo.com/video.mp4', 'https://cdn.bilivideo.com/video.mp4\n',
    'https://cdn.bilivideo.com\\video.mp4', '', 'https://cdn.bilivideo.com/' + 'x'.repeat(8200),
  ]) assert.throws(() => parsePlayback(upstream({ durl: [{ order: 1, url }] })), code('MATCH_UNAVAILABLE'), url);
});

test('media host matching excludes suffix tricks, alternate CDN families, loopback, and malformed labels', () => {
  for (const host of [
    'bilivideo.com', 'evilbilivideo.com', 'bilivideo.com.evil.example', 'cdn.bilivideo.com.evil.example',
    'cdn.bilivideo.cn', 'bilibili.com', 'localhost', '127.0.0.1', '[::1]', '10.0.0.1',
    '.bilivideo.com', 'cdn..bilivideo.com', '-cdn.bilivideo.com', 'cdn-.bilivideo.com',
    'cdn.bilivideo.com.', 'cdn_b.bilivideo.com', 'x'.repeat(64) + '.bilivideo.com',
  ]) assert.throws(() => parsePlayback(upstream({ durl: [{ order: 1, url: `https://${host}/movie.mp4` }] })), code('MATCH_UNAVAILABLE'), host);
});

test('metadata resolution requests 1080p, allowing the upstream to return the best available MP4', async () => {
  const taskSignal = signal();
  const calls: Parameters<Fetch>[] = [];
  const fetch: Fetch = async (...args) => { calls.push(args); return upstream(); };
  assert.deepEqual(await resolvePlayback(segment, taskSignal, { fetch }), { url: mediaUrl });
  assert.deepEqual(calls, [[
    '/x/player/playurl',
    { bvid: segment.bvid, cid: segment.cid, fnval: 0, fnver: 0, qn: 80, platform: 'html5', high_quality: 1 },
    {}, taskSignal,
  ]]);
});

test('720p and 1080p MP4 declarations are accepted without exposing or trusting their claimed quality', () => {
  for (const format of ['mp4720', 'mp41080']) {
    assert.deepEqual(parsePlayback(upstream({ format })), { url: mediaUrl });
  }
});

test('only explicitly supplied session headers are used and never returned to the browser', async () => {
  const headers = { Cookie: 'SESSDATA=synthetic-only' };
  const fetch: Fetch = async (_path, _params, actualHeaders) => {
    assert.deepEqual(actualHeaders, headers);
    return upstream({ format: 'mp41080' });
  };
  const result = await resolvePlayback(segment, signal(), { fetch, headers });
  assert.deepEqual(result, { url: mediaUrl });
  assert.doesNotMatch(JSON.stringify(result), /Cookie|SESSDATA|synthetic-only/);
});

test('invalid BV, CID, page, or extra request fields stop before any upstream call', async () => {
  let calls = 0;
  const fetch: Fetch = async () => { calls++; return upstream(); };
  for (const invalid of [
    null, {}, { ...segment, bvid: 'bad' }, { ...segment, cid: 0 }, { ...segment, cid: 1.5 },
    { ...segment, cid: Number.MAX_SAFE_INTEGER + 1 }, { ...segment, cid: '42710992429' },
    { ...segment, page: 0 }, { ...segment, page: 1001 }, { ...segment, page: 1.5 },
    { ...segment, url: mediaUrl }, { ...segment, Cookie: 'not accepted' },
  ]) await assert.rejects(resolvePlayback(invalid as Segment, signal(), { fetch }), code('MATCH_UNAVAILABLE'));
  assert.equal(calls, 0);
});

test('pre-cancelled resolution never calls upstream', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch: Fetch = async () => { assert.fail('Cancelled work must not make a request'); };
  await assert.rejects(resolvePlayback(segment, controller.signal, { fetch }), code('CANCELLED'));
});

test('cancellation is forwarded to an active request and cannot return its late successful URL', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  let release!: (value: unknown) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetch: Fetch = async (_path, _params, _headers, taskSignal) => {
    assert.equal(taskSignal, controller.signal);
    entered();
    return new Promise(resolve => { release = resolve; });
  };
  const pending = resolvePlayback(segment, controller.signal, { fetch });
  const rejected = assert.rejects(pending, code('CANCELLED'));
  await started;
  controller.abort();
  release(upstream());
  await rejected;
});

test('cancellation wins over a simultaneous network failure', async () => {
  const controller = new AbortController();
  const fetch: Fetch = async () => {
    controller.abort();
    throw new Error('network error');
  };
  await assert.rejects(resolvePlayback(segment, controller.signal, { fetch }), code('CANCELLED'));
});

test('HTTP and wrapped API rate limits become RATE_LIMITED', async () => {
  for (const failure of [
    { statusCode: 412 }, { statusCode: 429 }, { code: -352 }, { code: '-412' },
    { code: 'API_ERROR', originalError: { code: -352 } },
    { code: 'API_ERROR', originalError: { code: -412 } },
  ]) {
    const fetch: Fetch = async () => { throw failure; };
    await assert.rejects(resolvePlayback(segment, signal(), { fetch }), code('RATE_LIMITED'));
  }
});

test('unavailable and restricted videos cannot fall back to another format or login flow', async () => {
  for (const failure of [
    { statusCode: 403 }, { statusCode: 404 }, { code: 'ACCESS_DENIED' }, { name: 'PaidVideoError' },
    { code: 'API_ERROR', originalError: { code: -403 } },
    { code: 'API_ERROR', originalError: { code: -404 } },
  ]) {
    const fetch: Fetch = async () => { throw failure; };
    await assert.rejects(resolvePlayback(segment, signal(), { fetch }), code('MATCH_UNAVAILABLE'));
  }
  const fetch: Fetch = async () => upstream({ format: 'flv' });
  await assert.rejects(resolvePlayback(segment, signal(), { fetch }), code('MATCH_UNAVAILABLE'));
});

test('unexpected upstream errors retain neither signed locations nor upstream error causes', async () => {
  for (const failure of [
    new Error('failed at ' + mediaUrl), { statusCode: 500, message: mediaUrl }, null,
    new ReplayError('INTERNAL', { cause: new Error(mediaUrl) }),
  ]) {
    const fetch: Fetch = async () => { throw failure; };
    await assert.rejects(resolvePlayback(segment, signal(), { fetch }), error => {
      assert.ok(error instanceof ReplayError);
      assert.equal(error.code, 'SOURCE_UNAVAILABLE');
      assert.equal(error.message, 'SOURCE_UNAVAILABLE');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /deadline|sign|bilivideo/);
      return true;
    });
  }
});

test('expected application failures retain only their stable error code', async () => {
  for (const expected of ['SOURCE_UNAVAILABLE', 'RATE_LIMITED', 'CANCELLED', 'MATCH_UNAVAILABLE'] as const) {
    const fetch: Fetch = async () => { throw new ReplayError(expected, { cause: new Error(mediaUrl) }); };
    await assert.rejects(resolvePlayback(segment, signal(), { fetch }), error => {
      assert.ok(error instanceof ReplayError);
      assert.equal(error.code, expected);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
