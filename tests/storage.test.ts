import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import {
  STORAGE_KEY, playerUrl, restoreReplay, saveReplay, validSegments, type Segment,
} from '../src/storage';

// These identifiers and cids are synthetic fixtures; no network requests occur.
const first: Segment = { bvid: 'BV1xx411c7mD', cid: 101, page: 1 };
const second: Segment = { bvid: 'BV1xx411c7mD', cid: 102, page: 2 };

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
}

let originalStorage: PropertyDescriptor | undefined;
let storage: MemoryStorage;
beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('saving persists only playback identifiers and the current segment position', () => {
  const untrusted = [
    { ...first, title: 'SPOILER_TITLE', score: '3:0', duration: 3600, secret: 'COOKIE_SECRET' },
    { ...second, explanation: 'RAW_AGENT_REASONING', thumbnail: 'https://example.invalid/cover' },
  ];
  saveReplay(untrusted, 1);
  const serialized = storage.getItem(STORAGE_KEY)!;
  assert.deepEqual(JSON.parse(serialized), { segments: [first, second], currentIndex: 1 });
  for (const forbidden of ['title', 'score', 'duration', 'secret', 'COOKIE_SECRET', 'explanation', 'thumbnail']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(restoreReplay(), { segments: [first, second], currentIndex: 1 });
});

test('restoration also removes extra fields from previously saved untrusted objects', () => {
  storage.setItem(STORAGE_KEY, JSON.stringify({
    segments: [{ ...first, title: 'SPOILER_TITLE', secret: 'COOKIE_SECRET' }, second],
    currentIndex: 1,
    query: 'PRIVATE_SEARCH',
    secret: 'TOP_LEVEL_SECRET',
    playbackSeconds: 999,
  }));
  const restored = restoreReplay();
  assert.deepEqual(restored, { segments: [first, second], currentIndex: 1 });
  saveReplay(restored!.segments, restored!.currentIndex);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), restored);
});

test('missing, malformed, empty and out-of-range saved state cannot restore a player', () => {
  assert.equal(restoreReplay(), null);
  const invalid = [
    '{broken', 'null', '[]', '42',
    JSON.stringify({ segments: [], currentIndex: 0 }),
    JSON.stringify({ segments: [first] }),
    ...[-1, 1, 1.5, '0', null].map(currentIndex => JSON.stringify({ segments: [first], currentIndex })),
    JSON.stringify({ segments: [{ ...first, bvid: 'javascript:alert(1)' }], currentIndex: 0 }),
    JSON.stringify({ segments: [{ ...first, cid: '101' }], currentIndex: 0 }),
    JSON.stringify({ segments: [{ ...first, page: 1001 }], currentIndex: 0 }),
  ];
  for (const value of invalid) {
    storage.setItem(STORAGE_KEY, value);
    assert.equal(restoreReplay(), null, value);
  }
});

test('duplicate playback identities are rejected even when their page labels differ', () => {
  assert.equal(validSegments([first, first]), false);
  assert.equal(validSegments([first, { ...first, page: 2 }]), false);
  assert.equal(validSegments([first, second]), true);
  storage.setItem(STORAGE_KEY, JSON.stringify({ segments: [first, { ...first, page: 2 }], currentIndex: 0 }));
  assert.equal(restoreReplay(), null);
});

test('segment validation enforces bounded lists and safe positive numeric identifiers', () => {
  for (const cid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '101']) {
    assert.equal(validSegments([{ ...first, cid }]), false, String(cid));
  }
  for (const page of [0, -1, 1.5, 1001, '1']) {
    assert.equal(validSegments([{ ...first, page }]), false, String(page));
  }
  assert.equal(validSegments([{ ...first, page: 1000 }]), true);
  const maximum = Array.from({ length: 1000 }, (_, index) => ({ ...first, cid: 100 + index, page: index + 1 }));
  assert.equal(validSegments(maximum), true);
  assert.equal(validSegments([...maximum, { ...first, cid: 99999 }]), false);
});

test('clearing a replay removes saved watching history without touching other storage', () => {
  storage.setItem('unrelated-setting', 'keep');
  saveReplay([first], 0);
  saveReplay([], 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem('unrelated-setting'), 'keep');
});

test('blocked browser storage does not prevent using the current session', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage denied'); },
  });
  assert.equal(restoreReplay(), null);
  assert.doesNotThrow(() => saveReplay([first], 0));
  assert.doesNotThrow(() => saveReplay([], 0));
});

test('official iframe URLs select the verified cid without relying on the p parameter', () => {
  const firstUrl = new URL(playerUrl(first));
  const nextUrl = new URL(playerUrl(second));
  assert.equal(firstUrl.origin, 'https://player.bilibili.com');
  assert.equal(firstUrl.pathname, '/player.html');
  assert.equal(firstUrl.searchParams.get('bvid'), first.bvid);
  assert.equal(firstUrl.searchParams.get('cid'), '101');
  assert.equal(nextUrl.searchParams.get('cid'), '102');
  assert.equal(firstUrl.searchParams.has('p'), false);
  assert.equal(nextUrl.searchParams.has('p'), false);
  assert.equal(firstUrl.searchParams.get('autoplay'), '1');
  assert.equal(firstUrl.searchParams.get('danmaku'), '0');
  assert.equal(firstUrl.searchParams.get('poster'), '0');
  assert.deepEqual([...firstUrl.searchParams.keys()].sort(), ['autoplay', 'bvid', 'cid', 'danmaku', 'poster']);
});
