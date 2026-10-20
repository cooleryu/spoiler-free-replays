import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { access } from 'node:fs/promises';
import { upstreamCli, root } from './paths';
import { BVID, ReplayError, parseMetadata, type Metadata, type Evidence } from './domain';

export interface BilibiliSource {
  credentials(signal: AbortSignal): Promise<{ configured: boolean; logged_in: boolean }>;
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
  metadata(bvid: string, signal: AbortSignal): Promise<Metadata>;
  close(): Promise<void>;
}
export interface SearchResult {
  bvid: string; title: string; description: string; author: string;
  published_at?: string | number; duration_seconds?: number;
}

function unpack(result: Record<string, unknown>): unknown {
  if (result.structuredContent) return result.structuredContent;
  const content = result.content as { type?: string; text?: string }[] | undefined;
  const text = content?.find(c => c.type === 'text')?.text;
  if (!text || text.length > 2_000_000) throw new ReplayError('TOOL_UNAVAILABLE');
  try { return JSON.parse(text); } catch { throw new ReplayError('TOOL_UNAVAILABLE'); }
}
export function upstreamError(raw: unknown): ReplayError {
  const data = raw as { code?: string; category?: string; details?: { api_code?: string | number } };
  if (data?.category === 'credentials' || data?.code === 'COOKIE_EXPIRED') return new ReplayError('BILIBILI_LOGIN');
  if (data?.code === 'VALIDATION_ERROR') return new ReplayError('INVALID_INPUT');
  if (data?.details?.api_code === -404 || data?.details?.api_code === '-404') return new ReplayError('NOT_FOUND');
  return new ReplayError('NETWORK');
}

export class Upstream implements BilibiliSource {
  private client = new Client({ name: 'local-replay', version: '0.1.0' });
  private transport: StdioClientTransport;
  private closing?: Promise<void>;
  constructor() {
    const env = getDefaultEnvironment();
    // Only the upstream process receives Bilibili credentials. No titles or credentials are logged.
    for (const key of ['BILIBILI_SESSDATA', 'BILIBILI_BILI_JCT', 'BILIBILI_DEDEUSERID',
      'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    this.transport = new StdioClientTransport({ command: process.execPath, args: [upstreamCli],
      cwd: root, stderr: 'ignore', env });
  }
  async connect(signal: AbortSignal) {
    try { await access(upstreamCli); } catch { throw new ReplayError('TOOL_UNAVAILABLE'); }
    signal.throwIfAborted();
    const abort = () => { void this.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try { await this.client.connect(this.transport, { timeout: 15_000 }); }
    catch { await this.close(); throw new ReplayError(signal.aborted ? 'CANCELLED' : 'TOOL_UNAVAILABLE'); }
    finally { signal.removeEventListener('abort', abort); }
  }
  private async call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (signal.aborted) throw new ReplayError('CANCELLED');
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined,
        { signal, timeout: 25_000, resetTimeoutOnProgress: false });
      const data = unpack(result);
      if (result.isError || (data as { error?: boolean })?.error) throw upstreamError(data);
      return data;
    } catch (e) {
      if (e instanceof ReplayError) throw e;
      throw new ReplayError(signal.aborted ? 'CANCELLED' : 'NETWORK');
    }
  }
  async credentials(signal: AbortSignal) {
    return z.object({ configured: z.boolean(), logged_in: z.boolean() })
      .parse(await this.call('check_bilibili_credentials', {}, signal));
  }
  async search(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    const data = await this.call('search_bilibili_videos', { query, limit: 10 }, signal);
    const parsed = z.object({ results: z.array(z.object({
      bvid: z.string().regex(BVID), title: z.string(), author: z.string(),
      description: z.string().default(''), published_at: z.union([z.string(), z.number()]).optional(),
      duration_seconds: z.number().optional(),
    })).max(10) }).safeParse(data);
    if (!parsed.success) throw new ReplayError('TOOL_UNAVAILABLE');
    return parsed.data.results;
  }
  async metadata(bvid: string, signal: AbortSignal): Promise<Metadata> {
    return parseMetadata(await this.call('get_video_metadata', { bvid_or_url: bvid }, signal), bvid);
  }
  async close() {
    this.closing ??= (async () => {
      try { await this.client.close(); } catch { /* Cleanup remains best effort. */ }
      try { await this.transport.close(); } catch { /* The transport may already be closed. */ }
    })();
    await this.closing;
  }
}

/** A task-local gate: enforces provenance and budgets independently of model instructions. */
export class ToolGate {
  readonly evidence: Evidence = { searches: 0, successfulSearches: 0, found: new Set(), metadata: new Map() };
  private metadataCalls = 0;
  private queries = new Set<string>();
  private busy = false;
  failure?: ReplayError;
  constructor(private source: BilibiliSource, private signal: AbortSignal) {}
  async call(name: unknown, args: unknown): Promise<unknown> {
    if (this.signal.aborted) throw new ReplayError('CANCELLED');
    if (this.failure) throw this.failure;
    if (this.busy) throw new ReplayError('BUSY');
    this.busy = true;
    try {
      if (name === 'search_bilibili_videos') {
        const parsed = z.object({ query: z.string().trim().min(1).max(100) }).strict().safeParse(args);
        if (!parsed.success) throw new ReplayError('INVALID_INPUT');
        if (this.evidence.searches >= 4 || this.queries.has(parsed.data.query)) throw new ReplayError('INCOMPLETE');
        this.queries.add(parsed.data.query); this.evidence.searches++;
        const results = await this.source.search(parsed.data.query, this.signal);
        this.evidence.successfulSearches++;
        for (const result of results) this.evidence.found.add(result.bvid);
        return { untrusted_video_data: results };
      }
      if (name === 'get_video_metadata') {
        const parsed = z.object({ bvid_or_url: z.string().regex(BVID) }).strict().safeParse(args);
        if (!parsed.success) throw new ReplayError('INVALID_INPUT');
        const bvid = parsed.data.bvid_or_url;
        if (!this.evidence.found.has(bvid)) throw new ReplayError('INCOMPLETE');
        if (this.evidence.metadata.has(bvid)) return { untrusted_video_data: this.evidence.metadata.get(bvid) };
        if (++this.metadataCalls > 8) throw new ReplayError('INCOMPLETE');
        const metadata = await this.source.metadata(bvid, this.signal);
        this.evidence.metadata.set(bvid, metadata);
        return { untrusted_video_data: metadata };
      }
      throw new ReplayError('INVALID_INPUT');
    } catch (e) {
      const error = e instanceof ReplayError ? e : new ReplayError('NETWORK');
      if (['NETWORK', 'BILIBILI_LOGIN', 'TOOL_UNAVAILABLE', 'CANCELLED'].includes(error.code)) this.failure = error;
      throw error;
    } finally { this.busy = false; }
  }
}
