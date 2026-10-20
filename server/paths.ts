import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const localDir = resolve(root, '.local');
export const upstreamCli = resolve(root, 'node_modules/@xzxzzx/bilibili-mcp/dist/cli.js');
