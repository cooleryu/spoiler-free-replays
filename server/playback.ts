import { z } from 'zod';
import { fetchWithoutWBI } from '@xzxzzx/bilibili-mcp/dist/bilibili/http.js';
import { ReplayError, segmentSchema, type Segment } from './domain';

// The verified anonymous progressive MP4 used a subdomain of bilivideo.com.
// Keep this list aligned with media-src; DASH's other CDN families are not needed here.
export const ALLOWED_MEDIA_HOST_SUFFIXES = ['.bilivideo.com'] as const;

export interface Playback { url: string }
type PlaybackFetch = (
  path: string, params: Record<string, string | number>, headers: Record<string, string>, signal: AbortSignal,
) => Promise<unknown>;
export interface PlaybackDependencies { fetch?: PlaybackFetch; headers?: Record<string, string> }

const playbackSchema = z.object({
  format: z.enum(['mp4', 'mp4720', 'mp41080']),
  durl: z.array(z.object({ order: z.literal(1), url: z.string().min(1).max(8192) })).length(1),
  dash: z.null().optional(),
});

function allowedMediaUrl(value: string): string {
  // URL() otherwise silently normalizes whitespace, backslashes, or empty userinfo.
  if (/[\u0000-\u0020\u007f\\]/.test(value) || value.includes('#')) throw new ReplayError('MATCH_UNAVAILABLE');
  const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || authority.includes('@')) throw new ReplayError('MATCH_UNAVAILABLE');
  let url: URL;
  try { url = new URL(value); } catch { throw new ReplayError('MATCH_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || url.hostname.length > 253
    || !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || !ALLOWED_MEDIA_HOST_SUFFIXES.some(suffix => url.hostname.length > suffix.length && url.hostname.endsWith(suffix))) {
    throw new ReplayError('MATCH_UNAVAILABLE');
  }
  return url.toString();
}

/** Validate the upstream's single progressive MP4 declaration; never forward its other metadata. */
export function parsePlayback(raw: unknown): Playback {
  const parsed = playbackSchema.safeParse(raw);
  if (!parsed.success) throw new ReplayError('MATCH_UNAVAILABLE');
  return { url: allowedMediaUrl(parsed.data.durl[0].url) };
}

function playbackFailure(error: unknown, signal: AbortSignal): ReplayError {
  if (signal.aborted) return new ReplayError('CANCELLED');
  if (error instanceof ReplayError && ['SOURCE_UNAVAILABLE', 'RATE_LIMITED', 'CANCELLED', 'MATCH_UNAVAILABLE'].includes(error.code)) {
    return new ReplayError(error.code);
  }
  const value = error as { code?: unknown; statusCode?: unknown; name?: unknown; originalError?: { code?: unknown } } | null;
  const codes = [value?.code, value?.originalError?.code].map(String);
  if (value?.statusCode === 412 || value?.statusCode === 429 || codes.some(code => ['-352', '-412'].includes(code))) {
    return new ReplayError('RATE_LIMITED');
  }
  if (value?.statusCode === 403 || value?.statusCode === 404 || value?.name === 'PaidVideoError'
    || codes.some(code => ['-403', '-404', 'ACCESS_DENIED'].includes(code))) {
    return new ReplayError('MATCH_UNAVAILABLE');
  }
  // Do not keep upstream messages/causes: they can contain temporary signed locations.
  return new ReplayError('SOURCE_UNAVAILABLE');
}

/** Resolve JSON only. The browser requests the media directly; there is no media download or proxy. */
export async function resolvePlayback(
  segment: Segment, signal: AbortSignal, dependencies: PlaybackDependencies = {},
): Promise<Playback> {
  if (signal.aborted) throw new ReplayError('CANCELLED');
  const parsed = segmentSchema.safeParse(segment);
  if (!parsed.success) throw new ReplayError('MATCH_UNAVAILABLE');
  try {
    const raw = await (dependencies.fetch ?? fetchWithoutWBI)('/x/player/playurl', {
      bvid: parsed.data.bvid, cid: parsed.data.cid,
      fnval: 0, fnver: 0, qn: 80, platform: 'html5', high_quality: 1,
    }, dependencies.headers ?? {}, signal);
    if (signal.aborted) throw new ReplayError('CANCELLED');
    return parsePlayback(raw);
  } catch (error) {
    throw playbackFailure(error, signal);
  }
}
