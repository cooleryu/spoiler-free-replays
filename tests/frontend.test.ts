import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App, { MatchList } from '../src/App';
import { readCatalog, updateTime, type Match } from '../src/catalog';
import { STORAGE_KEY } from '../src/storage';

// Static rendering verifies the UI contract; live playback is checked in a browser.
let savedValue: string | null;
let originalStorage: PropertyDescriptor | undefined;
beforeEach(() => {
  savedValue = null;
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => key === STORAGE_KEY ? savedValue : null },
  });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

const render = () => renderToStaticMarkup(createElement(App));
const match: Match = { id: 'match-1', date: '2026-10-13', event: '2026德玛西亚杯', home: 'BRO', away: 'LGD' };

test('the initial screen provides the fixed-source list and an optional login action without search or import', () => {
  const html = render();
  assert.match(html, /<main>/);
  assert.match(html, /<h1>比赛回放<\/h1>/);
  assert.match(html, /aria-label="解说来源"/);
  assert.match(html, /aria-pressed="true">官方/);
  assert.match(html, /aria-pressed="false">德云色/);
  assert.match(html, /公开检索可能有收录延迟/);
  assert.match(html, /正在获取近期比赛/);
  assert.match(html, /<button[^>]*class="refresh-button"[^>]*disabled=""/);
  assert.match(html, /aria-label="比赛观看区域"/);
  assert.match(html, /登录提升画质/);
  assert.doesNotMatch(html, /<form\b|<input\b|<iframe\b|<img\b|role="dialog"|导入|BV 号|搜索/);
});

test('match rows expose only the date, event, and matchup with an accessible play action', () => {
  const raw = { ...match, title: 'SPOILER_TITLE', score: 'SCORE_3_0', duration: 99999, thumbnail: 'spoiler-cover.jpg', segments: [1, 2, 3] };
  const html = renderToStaticMarkup(createElement(MatchList, { matches: [raw], onSelect: () => {} }));
  assert.match(html, /<ul[^>]*aria-label="近期比赛"/);
  assert.match(html, /<button[^>]*aria-label="10月13日 2026德玛西亚杯 BRO 对阵 LGD，观看比赛"/);
  assert.match(html, /<time dateTime="2026-10-13">10月13日<\/time>/);
  assert.match(html, />BRO<.*>VS<.*>LGD</);
  assert.doesNotMatch(html, /SPOILER_TITLE|SCORE_3_0|99999|spoiler-cover|<img\b|match-1|总局数|时长/);
});

test('catalog responses are validated and strip video metadata before entering state', () => {
  const data = readCatalog({
    status: 'ready', sourceName: '哔哩哔哩英雄联盟赛事', updatedAt: '2026-10-14T08:30:00Z', stale: false,
    matches: [{ ...match, title: 'SPOILER', bvid: 'BV1xx411c7mD', duration: 100 }],
    cookie: 'SECRET',
  });
  assert.deepEqual(data, { sourceName: '哔哩哔哩英雄联盟赛事', updatedAt: '2026-10-14T08:30:00Z', stale: false, matches: [match] });
  for (const invalid of [
    { status: 'ready', updatedAt: null, stale: false, matches: [{ ...match, date: '2026-02-30' }] },
    { status: 'ready', updatedAt: null, stale: false, matches: [match, match] },
    { status: 'ready', updatedAt: 'bad date', stale: false, matches: [match] },
    { status: 'ready', updatedAt: null, stale: false, matches: [{ ...match, away: '' }] },
    { status: 'error', code: 'SOURCE_UNAVAILABLE' },
  ]) assert.equal(readCatalog(invalid), null);
  assert.deepEqual(readCatalog({ status: 'ready', updatedAt: null, stale: true, matches: [], warning: 'SOURCE_UNAVAILABLE' }), {
    sourceName: '指定赛事账号', updatedAt: null, stale: true, matches: [], warning: 'SOURCE_UNAVAILABLE',
  });
  const bundled = readCatalog({
    status: 'ready', updatedAt: '2026-10-20T07:55:00Z', stale: true,
    bundled: true, matches: [match], warning: 'RATE_LIMITED', title: 'SPOILER',
  });
  assert.equal(bundled?.bundled, true);
  assert.equal(bundled?.stale, true);
  assert.equal(bundled?.warning, 'RATE_LIMITED');
  assert.equal(JSON.stringify(bundled).includes('SPOILER'), false);
});

test('the displayed update time uses China time regardless of the browser timezone', () => {
  assert.match(updateTime('2026-10-14T08:30:00Z'), /10.*14.*16:30/);
});

test('a saved replay waits for an explicit start and for the initial catalog request to finish', () => {
  savedValue = JSON.stringify({
    segments: [{ bvid: 'BV1xx411c7mD', cid: 101, page: 1 }, { bvid: 'BV1xx411c7mD', cid: 102, page: 2 }],
    currentIndex: 1,
  });
  const html = render();
  assert.match(html, /role="status">已准备好/);
  assert.match(html, /开始观看/);
  assert.match(html, /<button[^>]*class="primary-button start-button"[^>]*disabled=""/);
  assert.match(html, /返回比赛列表/);
  assert.doesNotMatch(html, /<iframe\b|<video\b|player\.bilibili\.com|autoplay=1|<form\b|refresh-button|继续观看/);
  assert.doesNotMatch(html, /BV1xx411c7mD|当前第|共\s*2\s*(?:段|局|场)|第\s*2\s*(?:段|局|场)/);
});

test('spoiler metadata and secrets from saved objects never enter the viewing markup', () => {
  const forbidden = ['RAW_SPOILER_TITLE', 'WINNER_3_TO_0', 'DURATION_99999', 'COOKIE_SECRET', 'RAW_REASONING'];
  savedValue = JSON.stringify({
    segments: [{
      bvid: 'BV1xx411c7mD', cid: 101, page: 1,
      title: forbidden[0], score: forbidden[1], duration: forbidden[2],
      cookie: forbidden[3], explanation: forbidden[4], thumbnail: 'https://example.invalid/spoiler-cover.jpg',
    }],
    currentIndex: 0, totalSegments: 999, query: 'PRIVATE_QUERY',
  });
  const html = render();
  assert.match(html, /已准备好/);
  for (const value of [...forbidden, 'spoiler-cover.jpg', 'PRIVATE_QUERY', 'totalSegments']) {
    assert.equal(html.includes(value), false, value);
  }
  assert.doesNotMatch(html, /<img\b|<time\b|比分|总时长|总片段数/);
});

test('corrupted or out-of-range saved sessions fall back to the match list', () => {
  for (const value of [
    '{broken json',
    JSON.stringify({ segments: [{ bvid: 'BV1xx411c7mD', cid: 101, page: 1 }], currentIndex: 4 }),
    JSON.stringify({ segments: [{ bvid: 'INVALID', cid: 101, page: 1 }], currentIndex: 0 }),
  ]) {
    savedValue = value;
    const html = render();
    assert.match(html, /近期比赛/);
    assert.match(html, /refresh-button/);
    assert.doesNotMatch(html, /<iframe\b|已准备好|<form\b|<input\b/);
  }
});
