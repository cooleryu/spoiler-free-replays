import type { Segment } from './storage';
import type { QualityOption } from './QualityMenu';

export interface PlaybackSource {
  url?: string;
  manifest?: string;
  quality: number;
  qualities: QualityOption[];
}

export class PlaybackRequestError extends Error {
  constructor(public code: string) { super(code); }
}

export function readPlaybackSource(value: unknown): PlaybackSource | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.status !== 'ready' || !Number.isSafeInteger(data.quality) || typeof data.quality !== 'number'
    || !Array.isArray(data.qualities) || data.qualities.length > 20) return null;
  const qualities: QualityOption[] = [];
  for (const item of data.qualities) {
    if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.quality)
      || item.quality < 1 || item.quality > 127 || typeof item.label !== 'string'
      || !item.label || item.label.length > 64 || /[<>\u0000-\u001f]/.test(item.label)
      || typeof item.available !== 'boolean' || typeof item.requiresLogin !== 'boolean'
      || typeof item.requiresVip !== 'boolean') return null;
    qualities.push({ quality: item.quality, label: item.label, available: item.available,
      requiresLogin: item.requiresLogin, requiresVip: item.requiresVip });
  }
  if (!qualities.some(option => option.quality === data.quality && option.available)
    || new Set(qualities.map(option => option.quality)).size !== qualities.length) return null;
  if (typeof data.manifest === 'string' && data.url === undefined) {
    if (data.manifest.length > 100_000 || !data.manifest.includes('<MPD')) return null;
    return { manifest: data.manifest, quality: data.quality, qualities };
  }
  if (typeof data.url !== 'string' || data.manifest !== undefined) return null;
  try {
    const url = new URL(data.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !['.bilivideo.com', '.bilivideo.cn'].some(suffix => url.hostname.endsWith(suffix))) return null;
    return { url: url.href, quality: data.quality, qualities };
  } catch { return null; }
}

async function settleCancellation(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 250);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function requestPlaybackSource(segment: Segment, signal: AbortSignal, quality: number, fetcher: typeof fetch = fetch): Promise<PlaybackSource> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw signal.reason;
    const response = await fetcher('/api/playback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: segment.bvid, cid: segment.cid, page: segment.page, quality }), signal,
    });
    const data: unknown = await response.json();
    if (signal.aborted) throw signal.reason;
    const source = response.ok ? readPlaybackSource(data) : null;
    if (source) return source;
    const code = data && typeof data === 'object' ? (data as Record<string, unknown>).code : undefined;
    if (attempt === 0 && response.status === 409 && code === 'BUSY') { await settleCancellation(signal); continue; }
    throw new PlaybackRequestError(code === 'BILIBILI_LOGIN' ? code : 'PLAYBACK_UNAVAILABLE');
  }
  throw new PlaybackRequestError('PLAYBACK_UNAVAILABLE');
}
