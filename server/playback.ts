import { z } from 'zod';
import { fetchWithoutWBI } from '@xzxzzx/bilibili-mcp/dist/bilibili/http.js';
import { ReplayError, segmentSchema, type Segment } from './domain';

// Keep source URLs limited to Bilibili's observed progressive and DASH CDN families.
// Keep this list aligned with media-src and the DASH fetcher's connect-src.
export const ALLOWED_MEDIA_HOST_SUFFIXES = ['.bilivideo.com', '.bilivideo.cn'] as const;

export interface QualityOption { quality: number; label: string; available: boolean; requiresLogin: boolean; requiresVip: boolean }
export interface Playback { url?: string; manifest?: string; quality: number; qualities: QualityOption[] }
type PlaybackFetch = (
  path: string, params: Record<string, string | number>, headers: Record<string, string>, signal: AbortSignal,
) => Promise<unknown>;
export interface PlaybackDependencies { fetch?: PlaybackFetch; headers?: Record<string, string>; quality?: number; loggedIn?: boolean }

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
export function parsePlayback(raw: unknown): { url: string } {
  const parsed = playbackSchema.safeParse(raw);
  if (!parsed.success) throw new ReplayError('MATCH_UNAVAILABLE');
  return { url: allowedMediaUrl(parsed.data.durl[0].url) };
}

const QUALITY_LABELS: Record<number, string> = {
  16: '360p', 32: '480p', 64: '720p', 74: '720p 60帧', 80: '1080p',
  112: '1080p 高码率', 116: '1080p 60帧', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K',
};
export const PLAYBACK_QUALITIES = Object.freeze(Object.keys(QUALITY_LABELS).map(Number));
function record(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}
function knownQuality(raw: unknown): raw is number {
  return typeof raw === 'number' && Object.hasOwn(QUALITY_LABELS, raw);
}

interface ProgressiveSource { url: string; quality: number }
function progressiveSource(raw: unknown): ProgressiveSource | undefined {
  try {
    const parsed = parsePlayback(raw);
    const data = record(raw)!;
    const quality = ({ mp4: 16, mp4720: 64, mp41080: 80 } as Record<string, number>)[String(data.format)];
    if (data.quality !== quality) return;
    return { ...parsed, quality };
  } catch { return; }
}

interface DashTrack {
  quality: number; url: string; mimeType: 'video/mp4' | 'audio/mp4'; codecs: string;
  bandwidth: number; width?: number; height?: number; frameRate?: string;
  initialization: string; indexRange: string;
}
interface DashSource { duration: number; videos: DashTrack[]; audio: DashTrack }
function byteRange(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^\d{1,8}-\d{1,8}$/.test(raw)) return;
  const [start, end] = raw.split('-').map(Number);
  if (end < start || end > 16_777_216 || end - start > 1_048_576) return;
  return `${start}-${end}`;
}
function trackSource(raw: unknown, kind: 'video' | 'audio'): DashTrack | undefined {
  const data = record(raw);
  if (!data || !Number.isSafeInteger(data.id) || !Number.isSafeInteger(data.bandwidth)
    || Number(data.bandwidth) <= 0 || Number(data.bandwidth) > 200_000_000) return;
  const mimeType = data.mimeType ?? data.mime_type;
  const codecs = data.codecs;
  if (typeof codecs !== 'string' || (kind === 'video'
    ? mimeType !== 'video/mp4' || !/^avc1\.[\da-f]{6}$/i.test(codecs) || !knownQuality(data.id)
    : !['audio/mp4', 'audio/m4a'].includes(String(mimeType)) || !/^mp4a\.40\.(?:2|5|29)$/.test(codecs))) return;
  const base = record(data.SegmentBase ?? data.segment_base);
  const initialization = byteRange(base?.Initialization ?? base?.initialization);
  const indexRange = byteRange(base?.indexRange ?? base?.index_range);
  if (!initialization || !indexRange) return;
  const candidates = [data.baseUrl ?? data.base_url,
    ...(Array.isArray(data.backupUrl ?? data.backup_url) ? (data.backupUrl ?? data.backup_url) as unknown[] : []).slice(0, 8)];
  const urls: string[] = [];
  for (const value of candidates) {
    if (typeof value !== 'string' || value.length > 8192) continue;
    try { const url = allowedMediaUrl(value); if (!urls.includes(url)) urls.push(url); }
    catch { /* Only another upstream-supplied allowed CDN may be used. */ }
  }
  // Observed mcdn responses allow browser Range/CORS; some ordinary CDN mirrors require a Bilibili referrer.
  const priority = (value: string) => {
    const hostname = new URL(value).hostname;
    return hostname.endsWith('.mcdn.bilivideo.cn') ? 0 : hostname.endsWith('.bilivideo.cn') ? 1 : 2;
  };
  urls.sort((left, right) => priority(left) - priority(right));
  const url = urls[0];
  if (!url) return;
  let dimensions: Pick<DashTrack, 'width' | 'height' | 'frameRate'> = {};
  if (kind === 'video') {
    if (![data.width, data.height].every(value => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 16384)) return;
    const rate = String(data.frameRate ?? data.frame_rate ?? '');
    if (!/^\d{1,3}(?:\.\d{1,6}|\/\d{1,6})?$/.test(rate)) return;
    const [numerator, denominator = '1'] = rate.split('/');
    const fps = Number(numerator) / Number(denominator);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return;
    dimensions = { width: Number(data.width), height: Number(data.height), frameRate: rate };
  }
  return { quality: Number(data.id), url, mimeType: kind === 'video' ? 'video/mp4' : 'audio/mp4', codecs,
    bandwidth: Number(data.bandwidth), initialization, indexRange, ...dimensions };
}
function dashSource(raw: unknown): DashSource | undefined {
  const data = record(raw);
  const dash = record(data?.dash);
  if (!dash || !Array.isArray(dash.video) || dash.video.length > 256 || !Array.isArray(dash.audio) || dash.audio.length > 64) return;
  const duration = Number(dash.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) return;
  const videos = dash.video.map(value => trackSource(value, 'video')).filter((value): value is DashTrack => Boolean(value));
  const audio = dash.audio.map(value => trackSource(value, 'audio')).filter((value): value is DashTrack => Boolean(value))
    .sort((left, right) => right.bandwidth - left.bandwidth)[0];
  if (!videos.length || !audio) return;
  return { duration, videos, audio };
}
function xml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]!);
}
function representation(track: DashTrack, id: string): string {
  return `<Representation id="${id}" bandwidth="${track.bandwidth}" codecs="${xml(track.codecs)}"${track.width ? ` width="${track.width}" height="${track.height}" frameRate="${xml(track.frameRate!)}"` : ''}><BaseURL>${xml(track.url)}</BaseURL><SegmentBase indexRange="${track.indexRange}" indexRangeExact="true"><Initialization range="${track.initialization}"/></SegmentBase></Representation>`;
}
function manifest(source: DashSource, video: DashTrack): string {
  const duration = `PT${source.duration.toFixed(3)}S`;
  return `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" minBufferTime="PT1.5S" mediaPresentationDuration="${duration}"><Period start="PT0S" duration="${duration}"><AdaptationSet contentType="video" mimeType="video/mp4">${representation(video, 'video')}</AdaptationSet><AdaptationSet contentType="audio" mimeType="audio/mp4">${representation(source.audio, 'audio')}</AdaptationSet></Period></MPD>`;
}
function qualityOptions(raws: unknown[], available: Set<number>, loggedIn: boolean): QualityOption[] {
  const advertised = new Set<number>(available);
  const vip = new Set<number>([112, 116, 120, 125, 126, 127]);
  for (const raw of raws) {
    const data = record(raw);
    if (Array.isArray(data?.accept_quality)) for (const quality of data.accept_quality.slice(0, 64)) if (knownQuality(quality)) advertised.add(quality);
    if (Array.isArray(data?.support_formats)) for (const value of data.support_formats.slice(0, 64)) {
      const format = record(value);
      if (!format || !knownQuality(format.quality)) continue;
      advertised.add(format.quality);
      if (format.need_vip === true || format.need_vip === 1) vip.add(format.quality);
    }
  }
  return [...advertised].sort((left, right) => right - left).map(quality => ({
    quality, label: QUALITY_LABELS[quality], available: available.has(quality) && (loggedIn || quality <= 64),
    requiresLogin: !loggedIn && quality > 64, requiresVip: vip.has(quality),
  }));
}

/** Only actual returned tracks are available; advertisement fields provide labels and login hints. */
export function parsePlaybackSources(progressiveRaw: unknown, dashRaw: unknown, requested: number, loggedIn: boolean): Playback {
  if (!knownQuality(requested)) throw new ReplayError('INVALID_INPUT');
  if (!loggedIn && requested > 64) throw new ReplayError('BILIBILI_LOGIN');
  const progressive = progressiveSource(progressiveRaw);
  const dash = dashSource(dashRaw);
  const videos = dash?.videos.filter(video => loggedIn || video.quality <= 64) ?? [];
  const available = new Set(videos.map(video => video.quality));
  if (progressive && (loggedIn || progressive.quality <= 64)) available.add(progressive.quality);
  const qualities = qualityOptions([progressiveRaw, dashRaw], available, loggedIn);
  const exactVideo = videos.find(video => video.quality === requested);
  if (progressive?.quality === requested) return { ...progressive, qualities };
  if (exactVideo && dash) return { manifest: manifest(dash, exactVideo), quality: exactVideo.quality, qualities };
  // An unavailable requested grade must not become a made-up label on a lower quality resource.
  const fallbackQuality = [...available].filter(quality => quality <= 64).sort((a, b) => b - a)[0]
    ?? [...available].filter(quality => quality <= requested).sort((a, b) => b - a)[0];
  if (fallbackQuality === undefined) throw new ReplayError('MATCH_UNAVAILABLE');
  if (progressive?.quality === fallbackQuality) return { ...progressive, qualities };
  const fallback = videos.find(video => video.quality === fallbackQuality);
  if (!fallback || !dash) throw new ReplayError('MATCH_UNAVAILABLE');
  return { manifest: manifest(dash, fallback), quality: fallback.quality, qualities };
}

function playbackFailure(error: unknown, signal: AbortSignal): ReplayError {
  if (signal.aborted) return new ReplayError('CANCELLED');
  if (error instanceof ReplayError && ['SOURCE_UNAVAILABLE', 'RATE_LIMITED', 'CANCELLED', 'MATCH_UNAVAILABLE', 'BILIBILI_LOGIN', 'INVALID_INPUT'].includes(error.code)) {
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

/** Resolve playback metadata only; media transport is handled separately by the server and player. */
export async function resolvePlayback(
  segment: Segment, signal: AbortSignal, dependencies: PlaybackDependencies = {},
): Promise<Playback> {
  if (signal.aborted) throw new ReplayError('CANCELLED');
  const parsed = segmentSchema.safeParse(segment);
  if (!parsed.success) throw new ReplayError('MATCH_UNAVAILABLE');
  const loggedIn = dependencies.loggedIn === true;
  const quality = dependencies.quality ?? (loggedIn ? 80 : 64);
  if (!knownQuality(quality)) throw new ReplayError('INVALID_INPUT');
  if (!loggedIn && quality > 64) throw new ReplayError('BILIBILI_LOGIN');
  try {
    const fetcher = dependencies.fetch ?? fetchWithoutWBI;
    const headers = loggedIn ? dependencies.headers ?? {} : {};
    const common = { bvid: parsed.data.bvid, cid: parsed.data.cid, fnver: 0 };
    const results = await Promise.allSettled([
      fetcher('/x/player/playurl', { ...common, fnval: 0, qn: Math.min(quality, 80), platform: 'html5', high_quality: 1 }, headers, signal),
      fetcher('/x/player/playurl', { ...common, fnval: 16, qn: quality, fourk: 1 }, headers, signal),
    ]);
    if (signal.aborted) throw new ReplayError('CANCELLED');
    const [progressive, dash] = results;
    if (progressive.status === 'rejected' && dash.status === 'rejected') throw progressive.reason;
    return parsePlaybackSources(progressive.status === 'fulfilled' ? progressive.value : undefined,
      dash.status === 'fulfilled' ? dash.value : undefined, quality, loggedIn);
  } catch (error) {
    throw playbackFailure(error, signal);
  }
}
