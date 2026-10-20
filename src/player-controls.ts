import type { Segment } from './storage';

export const SEEK_STEPS = [-60, -30, -5, 5, 30, 60] as const;
export type SeekStep = typeof SEEK_STEPS[number];
export type PlayerShortcut = 'play' | 'back' | 'forward' | 'mute' | 'fullscreen';

export function seekTarget(current: number, delta: number, duration: number): number {
  const position = Number.isFinite(current) && current > 0 ? current : 0;
  if (!(SEEK_STEPS as readonly number[]).includes(delta)) return position;
  const limit = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.05) : Infinity;
  return Math.min(limit, Math.max(0, position + delta));
}

export function playerShortcut(key: string, editingControl: boolean, modifier = false): PlayerShortcut | null {
  if (editingControl || modifier) return null;
  if (key === ' ' || key === 'Spacebar') return 'play';
  if (key === 'ArrowLeft') return 'back';
  if (key === 'ArrowRight') return 'forward';
  if (key.toLowerCase() === 'm') return 'mute';
  if (key.toLowerCase() === 'f') return 'fullscreen';
  return null;
}

export function lockNormalRate(media: { playbackRate: number; defaultPlaybackRate: number }): void {
  if (media.defaultPlaybackRate !== 1) media.defaultPlaybackRate = 1;
  if (media.playbackRate !== 1) media.playbackRate = 1;
}

export function mediaUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.status !== 'ready' || typeof result.url !== 'string') return null;
  try {
    const url = new URL(result.url);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function briefWait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 250);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

// One short BUSY retry accommodates cancellation cleanup; never poll the service.
export async function requestPlayback(segment: Segment, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw signal.reason;
    const response = await fetcher('/api/playback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: segment.bvid, cid: segment.cid, page: segment.page }), signal,
    });
    const data: unknown = await response.json();
    if (signal.aborted) throw signal.reason;
    const url = response.ok ? mediaUrl(data) : null;
    if (url) return url;
    if (attempt === 0 && response.status === 409 && data && typeof data === 'object' && (data as Record<string, unknown>).code === 'BUSY') {
      await briefWait(signal);
      continue;
    }
    throw new Error('PLAYBACK_UNAVAILABLE');
  }
  throw new Error('PLAYBACK_UNAVAILABLE');
}
