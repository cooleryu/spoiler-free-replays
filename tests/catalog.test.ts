import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  MatchCatalog, matchSegments, normalizeSearch, parseMatchTitle, recentCutoff, shanghaiDate,
  type Match, type PublicSource, type SourceConfig,
} from '../server/catalog';
import { ReplayError, type ErrorCode } from '../server/domain';
import worldsSeed from '../config/catalog.seed.json';

// Offline fixtures use public API field names and the titles visible in the supplied account screenshot.
// They do not claim a live fetch, current availability, or successful player playback.
const config: SourceConfig = {
  creatorMid: 50329118, sourceName: '哔哩哔哩英雄联盟赛事', query: '2026德玛西亚杯',
  event: '2026德玛西亚杯', year: 2026, lookbackDays: 2,
};
const NOW = Date.parse('2026-10-14T04:00:00Z');
const A = 'BV1xx411c7mD';
const B = 'BV1xx411c7mE';
const C = 'BV1xx411c7mF';
const signal = () => new AbortController().signal;
const code = (expected: ErrorCode) => (error: unknown) => error instanceof ReplayError && error.code === expected;
const seconds = (date: string) => Date.parse(date) / 1000;
const title = (home = 'BRO', away = 'LGD', day = 13) => `【2026德玛西亚杯】10月${day}日 ${home} vs ${away}`;
function row(overrides: Record<string, unknown> = {}) {
  return {
    type: 'video', mid: config.creatorMid, bvid: A, title: title(),
    pubdate: seconds('2026-10-13T07:00:00Z'), author: config.sourceName,
    description: 'Do not send descriptions or results to the client',
    play: 165000, favorites: 600, review: 336, duration: '219:01',
    pic: '//example.invalid/spoiler.jpg', ...overrides,
  };
}
const selected: Match = { id: A, date: '2026-10-13', event: config.event, home: 'BRO', away: 'LGD' };
const worldsConfig: SourceConfig = { ...config, query: '2026全球总决赛', event: '2026全球总决赛', lookbackDays: 7 };
const WORLDS_NOW = Date.parse('2026-10-20T08:00:00Z');
// Public /view fields verified anonymously on 2026-10-20; no cookies, media URLs or outcomes.
const worldsVideo = {
  bvid: 'BV1y8JS6eEtZ', title: '【2026全球总决赛】10月16日 FUR vs MVK',
  owner: { mid: 50329118 }, pubdate: 1792108681,
  pages: [
    { page: 1, cid: 42778036035, part: '第一局' },
    { page: 2, cid: 42778689843, part: '第二局' },
    { page: 3, cid: 42779412249, part: '第三局' },
    { page: 4, cid: 42778036047, part: '赛前评论' },
    { page: 5, cid: 42779807109, part: '赛后采访' },
  ],
};
const worldsMatch: Match = { id: worldsVideo.bvid, date: '2026-10-16', event: worldsConfig.event, home: 'FUR', away: 'MVK' };
function metadata(overrides: Record<string, unknown> = {}) {
  return {
    bvid: A, title: title(), owner: { mid: config.creatorMid, name: config.sourceName },
    desc: 'Result details', stat: { view: 165000, reply: 336 }, duration: 13141,
    pages: [
      { page: 1, cid: 1001, part: '第一局', duration: 3600 },
      { page: 2, cid: 1002, part: '第二局', duration: 3600 },
      { page: 3, cid: 1003, part: '第三局', duration: 3600 },
      { page: 4, cid: 1004, part: '赛后采访', duration: 2341 },
    ], ...overrides,
  };
}

class FakeSource implements PublicSource {
  videoListCalls = 0;
  videoCalls: string[] = [];
  result: unknown = { result: [row()] };
  details: unknown = metadata();
  listError?: unknown;
  videoError?: unknown;
  listHook?: (signal: AbortSignal) => Promise<unknown>;
  async videos(taskSignal: AbortSignal) {
    this.videoListCalls++;
    if (this.listError) throw this.listError;
    return this.listHook ? this.listHook(taskSignal) : this.result;
  }
  async video(bvid: string, _signal: AbortSignal) {
    this.videoCalls.push(bvid);
    if (this.videoError) throw this.videoError;
    return this.details;
  }
}
function fixture(cacheFile: string | null = null) {
  const source = new FakeSource();
  let now = NOW;
  const catalog = new MatchCatalog({ source, config, cacheFile, now: () => now });
  return { source, catalog, advance(ms: number) { now += ms; } };
}
async function tempCache(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'bilibili-catalog-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'catalog.json');
}

test('captured anonymous API field shapes yield the four observed recent matches and verified game parts', () => {
  // Selected public fields from the parent task's saved anonymous API responses; no request runs here.
  const captured = [
    { mid: 50329118, bvid: 'BV1P9pq63E1Y', title: '【<em class="keyword">2026</em>德玛西亚杯】10月13日 BRO vs LGD', pubdate: 1791892480 },
    { mid: 50329118, bvid: 'BV1JuWA6TEvg', title: '【<em class="keyword">2026</em>德玛西亚杯】10月13日 WE vs FLY', pubdate: 1791874801 },
    { mid: 50329118, bvid: 'BV1LNpo61EYp', title: '【<em class="keyword">2026</em>德玛西亚杯】10月12日 BFX vs JDG', pubdate: 1791804393 },
    { mid: 50329118, bvid: 'BV1t7pR6fEum', title: '【<em class="keyword">2026</em>德玛西亚杯】10月12日 KT vs VIT', pubdate: 1791788489 },
    { mid: 50329118, bvid: 'BV1BtH96uE58', title: '【<em class="keyword">2026</em>德玛西亚杯】10月8日 NAVI vs JDG', pubdate: 1791461156 },
    { mid: 38724510, bvid: 'BV1mrpy6aE3p', title: '【<em class="keyword">2026</em>德玛西亚杯957二路】WE vs FLY  BRO vs LGD(20261013)', pubdate: 1791956167 },
  ];
  const matches = normalizeSearch({ result: captured }, NOW, config);
  assert.deepEqual(matches.map(({ id, home, away }) => [id, home, away]), [
    ['BV1P9pq63E1Y', 'BRO', 'LGD'], ['BV1JuWA6TEvg', 'WE', 'FLY'],
    ['BV1LNpo61EYp', 'BFX', 'JDG'], ['BV1t7pR6fEum', 'KT', 'VIT'],
  ]);
  const result = matchSegments({
    bvid: 'BV1P9pq63E1Y', title: title(), owner: { mid: 50329118 },
    pages: [
      { page: 1, cid: 42710992429, part: '第一局' },
      { page: 2, cid: 42712239456, part: '第二局' },
      { page: 3, cid: 42713482752, part: '第三局' },
      { page: 4, cid: 42714596500, part: '第四局' },
      { page: 5, cid: 42714597414, part: '赛后采访' },
    ],
  }, matches[0], config);
  assert.deepEqual(result.map(({ cid, page }) => [cid, page]), [
    [42710992429, 1], [42712239456, 2], [42713482752, 3], [42714596500, 4],
  ]);
});

test('verified Worlds metadata uses the existing exact title grammar and excludes pre-match commentary', () => {
  assert.deepEqual(parseMatchTitle(worldsVideo.title, worldsVideo.bvid, worldsConfig), worldsMatch);
  assert.deepEqual(matchSegments(worldsVideo, worldsMatch, worldsConfig), [
    { bvid: worldsVideo.bvid, cid: 42778036035, page: 1 },
    { bvid: worldsVideo.bvid, cid: 42778689843, page: 2 },
    { bvid: worldsVideo.bvid, cid: 42779412249, page: 3 },
  ]);
  const bad = { ...worldsVideo, pages: [...worldsVideo.pages, { page: 6, cid: 1006, part: '赛前评论：FUR获胜' }] };
  assert.throws(() => matchSegments(bad, worldsMatch, worldsConfig), code('MATCH_UNAVAILABLE'));
  assert.equal(parseMatchTitle(worldsVideo.title + ' 3:0', worldsVideo.bvid, worldsConfig), null);
});

test('the verified latest Worlds match excludes only the exact Swiss draw ceremony label', () => {
  const selected: Match = { id: 'BV1STnL6LEiW', date: '2026-10-19', event: worldsConfig.event, home: 'KC', away: 'MVK' };
  const video = { bvid: selected.id, title: '【2026全球总决赛】10月19日 KC vs MVK', owner: { mid: 50329118 },
    pages: [
      { page: 1, cid: 42856091452, part: '第一局' },
      { page: 2, cid: 42856484092, part: '第二局' },
      { page: 3, cid: 42856941713, part: '第三局' },
      { page: 4, cid: 42857008420, part: '瑞士轮抽签' },
      { page: 5, cid: 42856091285, part: '赛前评论' },
    ] };
  assert.deepEqual(matchSegments(video, selected, worldsConfig), [
    { bvid: selected.id, cid: 42856091452, page: 1 },
    { bvid: selected.id, cid: 42856484092, page: 2 },
    { bvid: selected.id, cid: 42856941713, page: 3 },
  ]);
  for (const label of ['瑞士轮抽签结果', '瑞士轮抽签 KC获胜', '附加节目']) {
    const pages = video.pages.map(page => page.page === 4 ? { ...page, part: label } : page);
    assert.throws(() => matchSegments({ ...video, pages }, selected, worldsConfig), code('MATCH_UNAVAILABLE'));
  }
});

test('the bundled verified directory is explicitly stale, date-bounded and revalidated on watch', async () => {
  const source = new FakeSource();
  source.details = worldsVideo;
  let now = WORLDS_NOW;
  const catalog = new MatchCatalog({ source, config: worldsConfig, cacheFile: null, now: () => now });
  const result = await catalog.get(signal());
  assert.equal(result.bundled, true);
  assert.equal(result.stale, true);
  assert.equal(result.updatedAt, worldsSeed.updatedAt);
  assert.deepEqual(result.matches.map(m => [m.id, m.home, m.away]), [
    ['BV1STnL6LEiW', 'KC', 'MVK'], ['BV15VJ66sEvH', 'MVK', 'FUR'], ['BV1LoJh6PENc', 'C9', 'FUR'],
    ['BV1y8JS6eEtZ', 'FUR', 'MVK'], ['BV1qrJm6EE6J', 'C9', 'KC'],
  ]);
  assert.equal(source.videoListCalls, 0);
  assert.equal((await catalog.watch(worldsVideo.bvid, signal()))[0].cid, 42778036035);
  source.details = { ...worldsVideo, owner: { mid: 1 } };
  await assert.rejects(catalog.watch(worldsVideo.bvid, signal()), code('MATCH_UNAVAILABLE'));
  now = Date.parse('2026-10-28T00:00:00Z');
  assert.deepEqual((await catalog.get(signal())).matches, []);
  await assert.rejects(catalog.watch(worldsVideo.bvid, signal()), code('MATCH_UNAVAILABLE'));
});

test('blocked refresh retains bundled provenance; successful refresh clears it and persists a normal cache', async t => {
  const cacheFile = await tempCache(t);
  const source = new FakeSource();
  let now = WORLDS_NOW;
  const catalog = new MatchCatalog({ source, config: worldsConfig, cacheFile, now: () => now });
  const first = await catalog.get(signal());
  source.result = { v_voucher: 'synthetic-verification' };
  const blocked = await catalog.refresh(signal());
  assert.equal(blocked.bundled, true);
  assert.equal(blocked.warning, 'RATE_LIMITED');
  assert.equal(blocked.updatedAt, first.updatedAt);
  assert.deepEqual(blocked.matches, first.matches);
  now += 3000;
  source.result = { result: [{ mid: 50329118, ...worldsVideo }] };
  const fresh = await catalog.refresh(signal());
  assert.equal(fresh.bundled, undefined);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.updatedAt, new Date(now).toISOString());
  assert.deepEqual(fresh.matches, [worldsMatch]);
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(saved.bundled, undefined);
  const replacementSource = new FakeSource();
  const restarted = new MatchCatalog({ source: replacementSource, config: worldsConfig, cacheFile, now: () => now });
  assert.deepEqual(await restarted.get(signal()), fresh);
  assert.equal(replacementSource.videoListCalls, 0);
});

test('bundled data shares cache validation and can be disabled for isolated sources', async t => {
  const seedFile = await tempCache(t);
  const invalidSeeds = [
    { ...worldsSeed, creatorMid: 1 }, { ...worldsSeed, query: 'wrong event' },
    { ...worldsSeed, matches: [{ ...worldsSeed.matches[0], home: 'FUR 3:0' }] },
    { ...worldsSeed, matches: [worldsSeed.matches[0], worldsSeed.matches[0]] },
  ];
  for (const seed of invalidSeeds) {
    await writeFile(seedFile, JSON.stringify(seed));
    const source = new FakeSource(); source.result = { result: [] };
    const catalog = new MatchCatalog({ source, config: worldsConfig, cacheFile: null, seedFile, now: () => WORLDS_NOW });
    assert.deepEqual((await catalog.get(signal())).matches, []);
    assert.equal(source.videoListCalls, 1);
  }
  const source = new FakeSource(); source.result = { result: [] };
  const isolated = new MatchCatalog({ source, config: worldsConfig, cacheFile: null, seedFile: null, now: () => WORLDS_NOW });
  assert.equal((await isolated.get(signal())).bundled, undefined);
  assert.equal(source.videoListCalls, 1);
});

test('Shanghai dates include today and the previous two calendar days across the UTC boundary', () => {
  assert.equal(shanghaiDate(Date.parse('2026-10-13T15:59:59Z')), '2026-10-13');
  assert.equal(shanghaiDate(Date.parse('2026-10-13T16:00:00Z')), '2026-10-14');
  assert.equal(new Date(recentCutoff(NOW, 2)).toISOString(), '2026-10-11T16:00:00.000Z');
  const results = normalizeSearch({ result: [
    row({ bvid: A, pubdate: seconds('2026-10-11T16:00:00Z'), title: title('BFX', 'JDG', 12) }),
    row({ bvid: B, pubdate: seconds('2026-10-13T07:00:00Z') }),
    row({ bvid: C, pubdate: seconds('2026-10-14T03:59:59Z'), title: title('KT', 'VIT', 14) }),
    row({ bvid: 'BV1xx411c7mG', pubdate: seconds('2026-10-11T15:59:59Z') }),
    row({ bvid: 'BV1xx411c7mH', pubdate: NOW / 1000 + 301 }),
    row({ bvid: 'BV1xx411c7mJ', title: title('KT', 'VIT', 15) }),
  ] }, NOW, config);
  assert.deepEqual(results.map(({ id }) => id), [C, B, A]);
});

test('public search rows require the exact numeric creator mid and valid identities', () => {
  const results = normalizeSearch({ result: [row(),
    row({ bvid: B, mid: config.creatorMid + 1 }), row({ bvid: C, mid: String(config.creatorMid) }),
    row({ bvid: 'https://www.bilibili.com/video/' + A }), row({ bvid: 'BV0000000000' }),
    row({ pubdate: '1791874800' }), row({ mid: undefined }),
  ] }, NOW, config);
  assert.deepEqual(results.map(({ id }) => id), [A]);
});

test('only known search highlight markup is removed and no raw title is exposed', () => {
  assert.deepEqual(parseMatchTitle('【2026<em class="keyword">德玛西亚杯</em>】10月13日 <em>BRO</em> vs LGD', A, config), selected);
  assert.deepEqual(parseMatchTitle("【2026<em class='keyword'>德玛西亚杯</em>】10月13日 BRO vs LGD", A, config), selected);
  for (const value of [
    '<strong>' + title() + '</strong>', title('<em onclick="bad()">BRO</em>'),
    title('<em class="other">BRO</em>'), title('<img src=x>BRO'),
    title('BRO &amp; X'), title('BRO<script>x</script>'),
  ]) assert.equal(parseMatchTitle(value, A, config), null, value);
});

test('scores, highlights, interviews, wrong events, invalid dates, and ambiguous teams are excluded', () => {
  for (const value of [
    title() + ' 3:0', title('BRO 3：0'), title('BRO 3-0'), title() + ' 集锦',
    title() + ' 赛后采访', '【2026德玛西亚杯】10月13日 淘汰赛预告片',
    title().replace('2026德玛西亚杯', '2026全球总决赛'), title('BRO', 'BRO'),
    title('BRO', 'bro'), title().replace('10月13日', '2月30日'), title().replace('10月13日', '13月1日'),
  ]) assert.equal(parseMatchTitle(value, A, config), null, value);
  const result = normalizeSearch({ result: [row(), row({ bvid: B, title: title() + ' 集锦' })] }, NOW, config);
  assert.deepEqual(Object.keys(result[0]).sort(), ['away', 'date', 'event', 'home', 'id', 'publishedAt']);
  assert.equal(result.length, 1);
});

test('catalog results are deduplicated and sorted by publication time with deterministic ties', () => {
  const result = normalizeSearch({ result: [row({ bvid: B }), row({ bvid: C }), row(), row({ bvid: B }),
    row({ bvid: 'BV1xx411c7mG', pubdate: NOW / 1000 }),
  ] }, NOW, config);
  assert.deepEqual(result.map(({ id }) => id), ['BV1xx411c7mG', A, B, C]);
});

test('invalid public response envelopes fail instead of being presented as an empty successful list', () => {
  for (const raw of [null, {}, { result: null }, { data: { result: [] } }, { result: Array(101).fill(row()) }]) {
    assert.throws(() => normalizeSearch(raw, NOW, config), code('SOURCE_UNAVAILABLE'));
  }
  assert.deepEqual(normalizeSearch({ result: [] }, NOW, config), []);
});

test('a public search verification voucher is a restriction even inside a successful envelope', () => {
  // The anonymous search response observed on 2026-10-20 had only this field; no real voucher is kept.
  for (const raw of [{ v_voucher: 'synthetic-verification' }, { result: [], v_voucher: '' }]) {
    assert.throws(() => normalizeSearch(raw, NOW, config), code('RATE_LIMITED'));
  }
});

test('selected video metadata revalidates creator, BV identity, and all parsed match fields', () => {
  for (const overrides of [
    { owner: { mid: config.creatorMid + 1 } }, { owner: { mid: String(config.creatorMid) } },
    { bvid: B }, { title: title('WE', 'FLY') }, { title: title('BRO', 'LGD', 12) },
    { title: title().replace('2026德玛西亚杯', '2026全球总决赛') }, { title: title() + ' 3:0' },
  ]) assert.throws(() => matchSegments(metadata(overrides), selected, config), code('MATCH_UNAVAILABLE'));
});

test('verified game segments exclude interviews and contain only playback identities', () => {
  const result = matchSegments(metadata(), selected, config);
  assert.deepEqual(result, [1, 2, 3].map(page => ({ bvid: A, cid: 1000 + page, page })));
  assert.doesNotMatch(JSON.stringify(result), /title|part|stat|duration|desc|owner|赛后采访|Result/);
});

test('game parts are sorted numerically by their verified game labels, preserving their actual P numbers', () => {
  const pages = [
    { page: 3, cid: 1003, part: '第二局' },
    { page: 1, cid: 1001, part: '第三局' },
    { page: 4, cid: 1004, part: '赛后采访' },
    { page: 2, cid: 1002, part: '第1局' },
  ];
  assert.deepEqual(matchSegments(metadata({ pages }), selected, config), [
    { bvid: A, cid: 1002, page: 2 }, { bvid: A, cid: 1003, page: 3 }, { bvid: A, cid: 1001, page: 1 },
  ]);
});

test('missing or duplicate games, unknown parts, invalid identities, and empty games fail closed', () => {
  const parts = (values: string[]) => values.map((part, index) => ({ page: index + 1, cid: index + 1001, part }));
  const invalid = [
    parts(['第一局', '第三局']), parts(['第一局', '第一局']), parts(['第二局']),
    parts(['第一局', '决胜时刻']), parts(['第一局', '赛后采访：BRO获胜']), parts(['赛后采访']),
    parts(['第0局']), parts(['第十一局']), [],
    [{ page: 2, cid: 1001, part: '第一局' }], [{ page: 1, cid: -1, part: '第一局' }],
    [{ page: 1, cid: 1001, part: '第一局' }, { page: 2, cid: 1001, part: '第二局' }],
  ];
  for (const pages of invalid) assert.throws(() => matchSegments(metadata({ pages }), selected, config), code('MATCH_UNAVAILABLE'));
});

test('first get fetches a bounded catalog once and subsequent gets reuse its successful snapshot', async () => {
  const { source, catalog } = fixture();
  const first = await catalog.get(signal());
  assert.deepEqual(first, { status: 'ready', sourceName: config.sourceName,
    updatedAt: new Date(NOW).toISOString(), stale: false, matches: [selected] });
  assert.deepEqual(await catalog.get(signal()), first);
  assert.equal(source.videoListCalls, 1);
  assert.deepEqual(source.videoCalls, []);
  assert.doesNotMatch(JSON.stringify(first), /pubdate|publishedAt|title|description|pic|review|duration/);
});

test('explicit refresh actually calls the source and replaces the list and success timestamp', async () => {
  const { source, catalog, advance } = fixture();
  const first = await catalog.get(signal());
  advance(3000);
  source.result = { result: [row({ bvid: B, title: title('WE', 'FLY') })] };
  const next = await catalog.refresh(signal());
  assert.equal(source.videoListCalls, 2);
  assert.notEqual(next.updatedAt, first.updatedAt);
  assert.deepEqual(next.matches, [{ ...selected, id: B, home: 'WE', away: 'FLY' }]);
  assert.deepEqual(await catalog.get(signal()), next);
});

test('failed refresh preserves the old list and old success timestamp with an explicit stale warning', async () => {
  const { source, catalog, advance } = fixture();
  const first = await catalog.get(signal());
  advance(3000);
  source.listError = new Error('offline fixture');
  const fallback = await catalog.refresh(signal());
  assert.deepEqual(fallback.matches, first.matches);
  assert.equal(fallback.updatedAt, first.updatedAt);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.warning, 'SOURCE_UNAVAILABLE');
  assert.equal(source.videoListCalls, 2);
});

test('a verification response preserves the previous successful catalog and its timestamp', async () => {
  const { source, catalog, advance } = fixture();
  const first = await catalog.get(signal());
  advance(3000);
  source.result = { v_voucher: 'synthetic-verification' };
  const fallback = await catalog.refresh(signal());
  assert.deepEqual(fallback.matches, first.matches);
  assert.equal(fallback.updatedAt, first.updatedAt);
  assert.equal(fallback.stale, true);
  assert.equal(fallback.warning, 'RATE_LIMITED');
  assert.equal(source.videoListCalls, 2);
});

test('refresh rate limiting lasts three seconds and never performs an extra fetch during the interval', async () => {
  const { source, catalog, advance } = fixture();
  const first = await catalog.get(signal());
  advance(2999);
  const limited = await catalog.refresh(signal());
  assert.equal(limited.warning, 'RATE_LIMITED');
  assert.equal(limited.updatedAt, first.updatedAt);
  assert.deepEqual(limited.matches, first.matches);
  assert.equal(source.videoListCalls, 1);
  advance(1);
  assert.equal((await catalog.refresh(signal())).warning, undefined);
  assert.equal(source.videoListCalls, 2);
});

test('initial source errors and initial retry limits never become successful empty lists', async () => {
  const { source, catalog, advance } = fixture();
  source.listError = { statusCode: 412 };
  await assert.rejects(catalog.get(signal()), code('RATE_LIMITED'));
  source.listError = undefined;
  await assert.rejects(catalog.get(signal()), code('RATE_LIMITED'));
  assert.equal(source.videoListCalls, 1);
  advance(3000);
  assert.equal((await catalog.get(signal())).matches.length, 1);
  assert.equal(source.videoListCalls, 2);
});

test('anonymous API rate limits retain the installed SDK nested error code', async () => {
  for (const error of [
    { statusCode: 429 }, { code: -352 }, { code: 'API_ERROR', originalError: { code: -352 } },
    { code: 'API_ERROR', originalError: { code: -412 } },
  ]) {
    const { source, catalog } = fixture();
    source.listError = error;
    await assert.rejects(catalog.get(signal()), code('RATE_LIMITED'));
    assert.equal(source.videoListCalls, 1);
  }
});

test('cached get becomes stale without background fetching and expires matches at the next date boundary', async () => {
  const { source, catalog, advance } = fixture();
  source.result = { result: [row({ pubdate: seconds('2026-10-11T16:00:00Z'), title: title('BRO', 'LGD', 12) })] };
  await catalog.get(signal());
  advance(15 * 60_000 + 1);
  assert.equal((await catalog.get(signal())).stale, true);
  advance(24 * 60 * 60_000);
  assert.deepEqual((await catalog.get(signal())).matches, []);
  assert.equal(source.videoListCalls, 1);
  await assert.rejects(catalog.watch(A, signal()), code('MATCH_UNAVAILABLE'));
  assert.equal(source.videoCalls.length, 0);
});

test('unknown match identifiers never trigger metadata fetching or an implicit list refresh', async () => {
  const { source, catalog } = fixture();
  await assert.rejects(catalog.watch(A, signal()), code('MATCH_UNAVAILABLE'));
  assert.equal(source.videoListCalls, 0);
  await catalog.get(signal());
  for (const id of [B, 'https://example.invalid/', '../catalog.json']) {
    await assert.rejects(catalog.watch(id, signal()), code('MATCH_UNAVAILABLE'));
  }
  assert.equal(source.videoListCalls, 1);
  assert.equal(source.videoCalls.length, 0);
  assert.equal((await catalog.watch(A, signal())).length, 3);
  assert.deepEqual(source.videoCalls, [A]);
});

test('pre-cancelled get, refresh, and watch do not make upstream requests', async () => {
  const { source, catalog } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(catalog.get(controller.signal), code('CANCELLED'));
  await assert.rejects(catalog.refresh(controller.signal), code('CANCELLED'));
  assert.equal(source.videoListCalls, 0);
  await catalog.get(signal());
  await assert.rejects(catalog.watch(A, controller.signal), code('CANCELLED'));
  assert.equal(source.videoCalls.length, 0);
});

test('cancelled active refresh neither records a success nor overwrites the persisted snapshot', async t => {
  const cacheFile = await tempCache(t);
  const { source, catalog, advance } = fixture(cacheFile);
  const first = await catalog.get(signal());
  const originalFile = await readFile(cacheFile, 'utf8');
  advance(3000);
  const controller = new AbortController();
  source.listHook = async () => {
    controller.abort();
    return { result: [row({ bvid: B })] };
  };
  await assert.rejects(catalog.refresh(controller.signal), code('CANCELLED'));
  assert.deepEqual(await catalog.get(signal()), first);
  assert.equal(await readFile(cacheFile, 'utf8'), originalFile);
});

test('a simultaneous refresh is rejected as busy and cannot replace the pending result', async () => {
  const { source, catalog } = fixture();
  let release!: (value: unknown) => void;
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  source.listHook = async () => {
    started();
    return new Promise(resolve => { release = resolve; });
  };
  const pending = catalog.get(signal());
  await didStart;
  try {
    await assert.rejects(catalog.refresh(signal()), code('BUSY'));
    assert.equal(source.videoListCalls, 1);
  } finally {
    release({ result: [row()] });
    await pending;
  }
});

test('file cache restores safe match fields without network calls or stored source metadata', async t => {
  const cacheFile = await tempCache(t);
  const initial = fixture(cacheFile);
  const first = await initial.catalog.get(signal());
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(saved.matches[0]).sort(), ['away', 'date', 'event', 'home', 'id', 'publishedAt']);
  saved.matches[0].title = 'spoiler';
  saved.matches[0].stats = { reply: 100 };
  saved.matches[0].duration = 100;
  await writeFile(cacheFile, JSON.stringify(saved));
  const restored = fixture(cacheFile);
  assert.deepEqual(await restored.catalog.get(signal()), first);
  assert.equal(restored.source.videoListCalls, 0);
  assert.doesNotMatch(JSON.stringify(await restored.catalog.get(signal())), /spoiler|stats|duration/);
});

test('cache validation rejects mismatched source and corrupt identity records before restoring', async t => {
  const cacheFile = await tempCache(t);
  const initial = fixture(cacheFile);
  await initial.catalog.get(signal());
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  for (const corrupt of [
    { ...saved, creatorMid: 1 }, { ...saved, query: 'unrelated' }, { ...saved, updatedAt: 'invalid' },
    { ...saved, matches: [saved.matches[0], saved.matches[0]] },
    { ...saved, matches: [{ ...saved.matches[0], id: 'bad' }] },
    { ...saved, matches: [{ ...saved.matches[0], home: 'BRO 3:0' }] },
  ]) {
    await writeFile(cacheFile, JSON.stringify(corrupt));
    const restored = fixture(cacheFile);
    await restored.catalog.get(signal());
    assert.equal(restored.source.videoListCalls, 1);
  }
});

test('cache cannot reintroduce raw highlight markup into displayed team names', async t => {
  const cacheFile = await tempCache(t);
  const initial = fixture(cacheFile);
  await initial.catalog.get(signal());
  const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
  saved.matches[0].home = '<em>BRO</em>';
  await writeFile(cacheFile, JSON.stringify(saved));
  const restored = fixture(cacheFile);
  const result = await restored.catalog.get(signal());
  assert.deepEqual(result.matches, [selected]);
  assert.doesNotMatch(JSON.stringify(result), /<em>/);
});
