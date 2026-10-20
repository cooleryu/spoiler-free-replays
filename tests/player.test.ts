import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Player from '../src/Player';
import { lockNormalRate, mediaUrl, playerShortcut, requestPlayback, SEEK_STEPS, seekTarget } from '../src/player-controls';

const SEGMENT = { bvid: 'BV1xx411c7mD', cid: 101, page: 1 };
const URL = 'https://media.example.test/replay.mp4?signature=synthetic';

test('the player uses one inline video and custom controls without a native control surface', () => {
  const html = renderToStaticMarkup(createElement(Player, { segment: SEGMENT, onEnded: () => {} }));
  assert.equal((html.match(/<video\b/g) ?? []).length, 1);
  assert.match(html, /<video[^>]*playsInline=""/);
  assert.match(html, /disablePictureInPicture=""/);
  assert.match(html, /disableRemotePlayback=""/);
  assert.match(html, /controlsList="nodownload noplaybackrate noremoteplayback"/);
  assert.doesNotMatch(html, /<video[^>]*\scontrols(?:=|\s|>)/i);
  assert.doesNotMatch(html, /<iframe\b|<track\b|poster=|src=|当前时间|总时长|倍速|弹幕|剩余|当前第|总局数|清单已播完/);
  assert.match(html, /aria-label="比赛播放器"/);
  assert.match(html, /aria-label="全屏"/);
});

test('two seek buttons use a bounded three-choice step selector and all normal controls follow the picture', () => {
  const html = renderToStaticMarkup(createElement(Player, { segment: SEGMENT, onEnded: () => {} }));
  assert.match(html, /aria-label="后退 5 秒"/);
  assert.match(html, /aria-label="前进 5 秒"/);
  assert.equal((html.match(/aria-label="(?:后退|前进) \d+ 秒"/g) ?? []).length, 2);
  assert.equal((html.match(/<select\b/g) ?? []).length, 1);
  assert.match(html, /<label for="player-seek-step">每次<\/label>/);
  assert.match(html, /<select[^>]*aria-label="跳转幅度"/);
  assert.match(html, /<option value="5" selected="">5秒<\/option>/);
  assert.deepEqual([...html.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1])), [5, 30, 60]);
  const groups = ['media-stage', 'player-footer', 'player-bottom-controls', 'player-transport', 'player-step-control', 'volume-control', 'player-display-controls'];
  for (let index = 1; index < groups.length; index++) assert.ok(html.indexOf(`class="${groups[index - 1]}"`) < html.indexOf(`class="${groups[index]}"`));
  assert.doesNotMatch(html, /player-jumps|jump-caption|jump-divider/);
  assert.equal((html.match(/type="range"/g) ?? []).length, 1);
  assert.match(html, /<label for="player-volume">音量<\/label>/);
  assert.match(html, /<input[^>]*id="player-volume"[^>]*min="0"[^>]*max="1"[^>]*aria-label="音量"/);
  assert.doesNotMatch(html, /role="slider"|进度|时间轴|跳至|继续观看|BV1xx411c7mD|signature/);
});

test('seek targets accept only the allowed steps, clamp the start and stop short of forcing an ended event', () => {
  for (const step of SEEK_STEPS) assert.equal(seekTarget(100, step, 1000), 100 + step);
  assert.equal(seekTarget(3, -5, 1000), 0);
  assert.equal(seekTarget(990, 60, 1000), 999.95);
  assert.equal(seekTarget(20, 10, 1000), 20);
  assert.equal(seekTarget(NaN, 5, Infinity), 5);
});

test('keyboard shortcuts exclude the volume slider, interactive controls and browser modifiers', () => {
  assert.equal(playerShortcut(' ', false), 'play');
  assert.equal(playerShortcut('ArrowLeft', false), 'back');
  assert.equal(playerShortcut('ArrowRight', false), 'forward');
  assert.equal(playerShortcut('M', false), 'mute');
  assert.equal(playerShortcut('f', false), 'fullscreen');
  for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'm', 'f']) {
    assert.equal(playerShortcut(key, true), null);
    assert.equal(playerShortcut(key, false, true), null);
  }
  for (const key of ['0', '9', 'Home', 'End', '<', '>', 'ArrowUp', 'ArrowDown']) assert.equal(playerShortcut(key, false), null);
});

test('normal playback rate is restored both for the current media and future sources', () => {
  const media = { playbackRate: 2, defaultPlaybackRate: 0.5 };
  lockNormalRate(media);
  assert.deepEqual(media, { playbackRate: 1, defaultPlaybackRate: 1 });
  lockNormalRate(media);
  assert.deepEqual(media, { playbackRate: 1, defaultPlaybackRate: 1 });
});

test('playback resolution sends only the segment identifiers and accepts only a safe HTTPS media address', async () => {
  const controller = new AbortController();
  const fixtureFetch = (async (input, init) => {
    assert.equal(input, '/api/playback');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.signal, controller.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), SEGMENT);
    return new Response(JSON.stringify({ status: 'ready', url: URL, duration: 'must-not-be-retained' }));
  }) as typeof fetch;
  assert.equal(await requestPlayback({ ...SEGMENT, secret: 'not-sent' } as typeof SEGMENT, controller.signal, fixtureFetch), URL);
  for (const url of ['http://media.example.test/file.mp4', 'javascript:alert(1)', '//media.example.test/file.mp4', 'https://user:secret@media.example.test/file.mp4']) {
    assert.equal(mediaUrl({ status: 'ready', url }), null);
  }
  assert.equal(mediaUrl({ status: 'error', url: URL }), null);
});

test('BUSY receives one bounded short retry and is never polled indefinitely', async () => {
  let calls = 0;
  const busy = () => new Response(JSON.stringify({ status: 'error', code: 'BUSY' }), { status: 409 });
  const recovered = (async () => ++calls === 1 ? busy() : new Response(JSON.stringify({ status: 'ready', url: URL }))) as typeof fetch;
  assert.equal(await requestPlayback(SEGMENT, new AbortController().signal, recovered), URL);
  assert.equal(calls, 2);
  calls = 0;
  const blocked = (async () => { calls++; return busy(); }) as typeof fetch;
  await assert.rejects(requestPlayback(SEGMENT, new AbortController().signal, blocked), /PLAYBACK_UNAVAILABLE/);
  assert.equal(calls, 2);
});

test('aborting during the BUSY delay prevents another source request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const busy = (async () => {
    calls++;
    setTimeout(() => controller.abort(new Error('test cancellation')), 10);
    return new Response(JSON.stringify({ status: 'error', code: 'BUSY' }), { status: 409 });
  }) as typeof fetch;
  await assert.rejects(requestPlayback(SEGMENT, controller.signal, busy), /test cancellation/);
  assert.equal(calls, 1);
});
