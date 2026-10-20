import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { ReplayError, parseMetadata, validateSelection, type ErrorCode, type Metadata } from '../server/domain';
import { prepareReplay } from '../server/prepare';
import { ToolGate, type BilibiliSource, type SearchResult } from '../server/upstream';

// Offline fixtures shaped like the upstream responses. These tests do not prove playback or real search.
const IDS = [...'DEFGHJKLM'].map(last => `BV1xx411c7m${last}`);
const A = IDS[0];
const searchInput = { mode: 'search' as const, input: 'Fixture Cup A vs B 2026-01-01' };
const signal = () => new AbortController().signal;
function hasCode(code: ErrorCode) {
  return (error: unknown) => error instanceof ReplayError && error.code === code;
}
function upstreamMetadata(bvid: string): Metadata {
  const offset = (IDS.indexOf(bvid) + 1) * 100;
  return parseMetadata({
    bvid, title: 'Fixture A 3:0 B', author: 'Fixture uploader', description: 'Fixture result details',
    duration: 7200, pubdate: '2026-01-02T00:00:00Z', pubdate_timestamp: 1767312000,
    tags: ['fixture'], stats: { view: 20, like: 2 },
    pages: [3, 1, 2].map(page => ({ page, cid: offset + page, title: `Fixture game ${page}`, duration: 1200 })),
  }, bvid);
}

class FakeSource implements BilibiliSource {
  credentialCalls = 0;
  searchCalls: string[] = [];
  metadataCalls: string[] = [];
  closeCalls = 0;
  closed = false;
  closeWait?: Promise<void>;
  login = { configured: true, logged_in: true };
  searchError?: ReplayError;
  results: SearchResult[] = IDS.map(bvid => ({ bvid, title: 'Fixture A 3:0 B', author: 'Fixture uploader', description: 'Fixture details' }));
  async credentials(_signal: AbortSignal) { this.credentialCalls++; return this.login; }
  async search(query: string, _signal: AbortSignal) {
    this.searchCalls.push(query);
    if (this.searchError) throw this.searchError;
    return this.results;
  }
  async metadata(bvid: string, _signal: AbortSignal) {
    this.metadataCalls.push(bvid);
    return upstreamMetadata(bvid);
  }
  async close() { this.closeCalls++; await this.closeWait; this.closed = true; }
}
type Dependencies = NonNullable<Parameters<typeof prepareReplay>[2]>;
const check: Dependencies['check'] = async () => 'fixture-codex';
const noSelection: Dependencies['select'] = async () => { assert.fail('The Agent must not be started for this path'); };

test('missing Codex login or executable stops before Bilibili calls or Agent selection', async () => {
  for (const code of ['CODEX_LOGIN', 'CODEX_MISSING'] as const) {
    const source = new FakeSource();
    await assert.rejects(prepareReplay(searchInput, signal(), {
      source, select: noSelection, check: async () => { throw new ReplayError(code); },
    }), hasCode(code));
    assert.equal(source.credentialCalls, 0);
    assert.equal(source.searchCalls.length, 0);
    assert.equal(source.closeCalls, 1);
    assert.equal(source.closed, true);
  }
});

test('missing or expired Bilibili login stops before Agent selection', async () => {
  for (const login of [{ configured: false, logged_in: false }, { configured: true, logged_in: false }]) {
    const source = new FakeSource();
    source.login = login;
    await assert.rejects(prepareReplay(searchInput, signal(), { source, check, select: noSelection }), hasCode('BILIBILI_LOGIN'));
    assert.equal(source.credentialCalls, 1);
    assert.equal(source.searchCalls.length, 0);
    assert.equal(source.metadataCalls.length, 0);
    assert.equal(source.closed, true);
  }
});

test('manual import uses verified metadata and returns only playback identities from the requested page', async () => {
  const source = new FakeSource();
  const result = await prepareReplay({ mode: 'import', input: `https://www.bilibili.com/video/${A}?p=2` }, signal(), {
    source, select: noSelection, check: async () => { assert.fail('Manual import does not need Codex'); },
  });
  assert.deepEqual(result, [{ bvid: A, cid: 102, page: 2 }, { bvid: A, cid: 103, page: 3 }]);
  assert.deepEqual(source.metadataCalls, [A]);
  assert.equal(source.credentialCalls, 0);
  assert.equal(source.searchCalls.length, 0);
  assert.equal(source.closed, true);
  assert.doesNotMatch(JSON.stringify(result), /title|Fixture|duration|stats|author|description|3:0/);
});

test('manual import refuses an absent page or invalid URL without using the Agent', async () => {
  const source = new FakeSource();
  await assert.rejects(prepareReplay({ mode: 'import', input: `https://www.bilibili.com/video/${A}?p=4` }, signal(), {
    source, check, select: noSelection,
  }), hasCode('INCOMPLETE'));
  assert.equal(source.closed, true);
  const untouched = new FakeSource();
  await assert.rejects(prepareReplay({ mode: 'import', input: `http://127.0.0.1/video/${A}` }, signal(), {
    source: untouched, check, select: noSelection,
  }), hasCode('INVALID_INPUT'));
  assert.equal(untouched.metadataCalls.length, 0);
});

test('automatic preparation routes search and metadata through the gate and validates the final identities', async () => {
  const source = new FakeSource();
  let selected = 0;
  const result = await prepareReplay(searchInput, signal(), {
    source, check,
    select: async (query, gate, taskSignal) => {
      selected++;
      assert.equal(query, searchInput.input);
      assert.equal(taskSignal.aborted, false);
      const found = await gate.call('search_bilibili_videos', { query });
      assert.deepEqual(found, { untrusted_video_data: source.results });
      await gate.call('get_video_metadata', { bvid_or_url: A });
      assert.throws(() => validateSelection({ status: 'ready', segments: [{ bvid: A, page: 1, cid: 99999 }] }, gate.evidence), hasCode('INCOMPLETE'));
      return validateSelection({ status: 'ready', segments: [{ bvid: A, page: 1, cid: 101 }] }, gate.evidence);
    },
  });
  assert.deepEqual(result, [{ bvid: A, page: 1, cid: 101 }]);
  assert.equal(selected, 1);
  assert.deepEqual(source.searchCalls, [searchInput.input]);
  assert.deepEqual(source.metadataCalls, [A]);
  assert.equal(source.closed, true);
});

test('the search budget permits four distinct searches and refuses the fifth without upstream work', async () => {
  const source = new FakeSource();
  const gate = new ToolGate(source, signal());
  for (let i = 1; i <= 4; i++) await gate.call('search_bilibili_videos', { query: `fixture query ${i}` });
  await assert.rejects(gate.call('search_bilibili_videos', { query: 'fixture query 5' }), hasCode('INCOMPLETE'));
  assert.equal(source.searchCalls.length, 4);
  assert.equal(gate.evidence.searches, 4);
  assert.equal(gate.evidence.successfulSearches, 4);
});

test('repeating the same trimmed search query does not call upstream again', async () => {
  const source = new FakeSource();
  const gate = new ToolGate(source, signal());
  await gate.call('search_bilibili_videos', { query: 'fixture query' });
  await assert.rejects(gate.call('search_bilibili_videos', { query: '  fixture query  ' }), hasCode('INCOMPLETE'));
  assert.deepEqual(source.searchCalls, ['fixture query']);
});

test('metadata budget permits eight searched videos, caches repeats and refuses the ninth', async () => {
  const source = new FakeSource();
  const gate = new ToolGate(source, signal());
  await gate.call('search_bilibili_videos', { query: 'fixture query' });
  for (const bvid of IDS.slice(0, 8)) await gate.call('get_video_metadata', { bvid_or_url: bvid });
  const cached = await gate.call('get_video_metadata', { bvid_or_url: A });
  assert.deepEqual(cached, { untrusted_video_data: upstreamMetadata(A) });
  await assert.rejects(gate.call('get_video_metadata', { bvid_or_url: IDS[8] }), hasCode('INCOMPLETE'));
  assert.equal(source.metadataCalls.length, 8);
  assert.equal(gate.evidence.metadata.size, 8);
});

test('unsearched BV identifiers and non-whitelisted tools cannot reach upstream', async () => {
  const source = new FakeSource();
  const gate = new ToolGate(source, signal());
  await assert.rejects(gate.call('get_video_metadata', { bvid_or_url: A }), hasCode('INCOMPLETE'));
  await assert.rejects(gate.call('get_video_comments', { bvid_or_url: A }), hasCode('INVALID_INPUT'));
  await assert.rejects(gate.call('search_bilibili_videos', { query: 'fixture', cookie: 'not accepted' }), hasCode('INVALID_INPUT'));
  assert.equal(source.metadataCalls.length, 0);
  assert.equal(source.searchCalls.length, 0);
});

test('a search network failure is retained even after earlier successful evidence', async () => {
  const source = new FakeSource();
  const gate = new ToolGate(source, signal());
  await gate.call('search_bilibili_videos', { query: 'fixture initial query' });
  await gate.call('get_video_metadata', { bvid_or_url: A });
  source.searchError = new ReplayError('NETWORK');
  await assert.rejects(gate.call('search_bilibili_videos', { query: 'fixture follow-up query' }), hasCode('NETWORK'));
  assert.equal(gate.failure?.code, 'NETWORK');
  assert.equal(gate.evidence.successfulSearches, 1);
  source.searchError = undefined;
  await assert.rejects(gate.call('get_video_metadata', { bvid_or_url: A }), hasCode('NETWORK'));
  await assert.rejects(gate.call('search_bilibili_videos', { query: 'fixture retry query' }), hasCode('NETWORK'));
  assert.equal(source.searchCalls.length, 2);
  assert.equal(source.metadataCalls.length, 1);
});

test('a failed first search remains NETWORK rather than being reported as an empty result', async () => {
  const source = new FakeSource();
  source.searchError = new ReplayError('NETWORK');
  await assert.rejects(prepareReplay(searchInput, signal(), {
    source, check,
    select: async (query, gate) => {
      await gate.call('search_bilibili_videos', { query });
      return validateSelection({ status: 'not_found', segments: [] }, gate.evidence);
    },
  }), hasCode('NETWORK'));
  assert.equal(source.closed, true);
});

test('pre-cancelled preparation cleans up without checking login or starting the Agent', async () => {
  const source = new FakeSource();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareReplay(searchInput, controller.signal, {
    source, select: noSelection, check: async () => { assert.fail('Cancelled request must not check login'); },
  }), hasCode('CANCELLED'));
  assert.equal(source.credentialCalls, 0);
  assert.equal(source.closed, true);
});

test('cancelling active preparation closes the source and awaits cleanup before settling', async () => {
  const source = new FakeSource();
  const controller = new AbortController();
  let releaseCleanup!: () => void;
  source.closeWait = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let selectionStarted!: () => void;
  const started = new Promise<void>(resolve => { selectionStarted = resolve; });
  const prepared = prepareReplay(searchInput, controller.signal, {
    source, check,
    select: async (_query, _gate, taskSignal) => new Promise((_resolve, reject) => {
      taskSignal.addEventListener('abort', () => reject(new ReplayError('CANCELLED')), { once: true });
      selectionStarted();
    }),
  });
  let settled = false;
  const rejected = assert.rejects(prepared, hasCode('CANCELLED')).then(() => { settled = true; });
  try {
    await started;
    controller.abort();
    await nextTick();
    assert.ok(source.closeCalls >= 1);
    assert.equal(source.closed, false);
    assert.equal(settled, false);
    releaseCleanup();
    await rejected;
    assert.equal(source.closed, true);
  } finally {
    controller.abort(); releaseCleanup(); await rejected;
  }
});
