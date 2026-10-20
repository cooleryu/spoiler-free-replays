import type { IncomingMessage, ServerResponse } from 'node:http';
import { ReplayError } from './domain';

export async function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ReplayError('INVALID_INPUT');
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new ReplayError('INVALID_INPUT');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ReplayError('INVALID_INPUT');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ReplayError('INVALID_INPUT'); }
}
export function json(res: ServerResponse, code: number, data: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
export function allowedRequest(req: IncomingMessage, port: number, mutation = false) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  if (mutation && (!origin || req.headers['sec-fetch-site'] === 'cross-site')) return false;
  return true;
}
