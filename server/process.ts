import { spawn } from 'node:child_process';
import { ReplayError } from './domain';

export async function runProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal;
  timeout?: number; maxBytes?: number;
} = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options.signal?.aborted) throw new ReplayError('CANCELLED');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', failure: ReplayError | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    function kill(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    }
    function stop(code: 'TIMEOUT' | 'CANCELLED' | 'INTERNAL') {
      if (failure) return;
      failure = new ReplayError(code); kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 800); killTimer.unref();
    }
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('TIMEOUT'), options.timeout ?? 180_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const maxBytes = options.maxBytes ?? 2_000_000;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString(); if (stdout.length > maxBytes) stop('INTERNAL');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Never forward raw output to the UI or application logs.
      stderr = (stderr + chunk.toString()).slice(-16000);
    });
    child.stdin.on('error', () => {});
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      reject(new ReplayError(error.code === 'ENOENT' ? 'CODEX_MISSING' : 'INTERNAL'));
    });
    child.once('close', code => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      // Kill any MCP children left behind even if the main process exited first.
      kill('SIGKILL');
      if (failure) reject(failure); else resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(options.input ?? '');
  });
}
