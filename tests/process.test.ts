import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ReplayError, type ErrorCode } from '../server/domain';
import { runProcess } from '../server/process';

function hasCode(code: ErrorCode) {
  return (error: unknown) => error instanceof ReplayError && error.code === code;
}
async function waitForFile(path: string, limitMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    try { await access(path); return; } catch { await delay(15); }
  }
  assert.fail('Fixture process did not start within the test deadline');
}

test('process runs with literal argument arrays, never shell interpolation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-args-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'should-not-exist');
  const args = [`$(touch ${marker})`, `; touch ${marker}`, '`echo injected`', '${HOME}', 'space and "quotes"', '\nnewline'];
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), args);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('process forwards stdin and returns nonzero status without exposing it as a shell failure', async () => {
  const input = 'Untrusted fixture text: $(echo nope)\n比赛输入';
  const result = await runProcess(process.execPath, ['-e', `
    let text = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => text += chunk);
    process.stdin.on('end', () => { process.stdout.write(text); process.stderr.write('fixture error'); process.exitCode = 7; });
  `], { input });
  assert.deepEqual(result, { stdout: input, stderr: 'fixture error', code: 7 });
});

test('a pre-cancelled invocation is rejected before attempting to spawn', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProcess('/nonexistent/replay-test-command', [], { signal: controller.signal }), hasCode('CANCELLED'));
});

test('cancelling a running invocation waits for its child to be stopped', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'started');
  const controller = new AbortController();
  const result = runProcess(process.execPath, ['-e', `
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `, marker], { signal: controller.signal, timeout: 6000 });
  // Register rejection handling before cancellation to avoid unhandled rejections.
  const rejected = assert.rejects(result, hasCode('CANCELLED'));
  try {
    await waitForFile(marker);
    const pid = Number(await readFile(marker, 'utf8'));
    controller.abort();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await rejected;
  }
});

test('process timeout terminates unfinished work with a distinct TIMEOUT status', async () => {
  const started = Date.now();
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 70 }), hasCode('TIMEOUT'));
  assert.ok(Date.now() - started < 4000, 'Timed-out process must be cleaned up promptly');
});

test('cancellation escalates when a child ignores the first termination signal', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-force-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'started');
  const controller = new AbortController();
  const result = runProcess(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `, marker], { signal: controller.signal, timeout: 6000 });
  const rejected = assert.rejects(result, hasCode('CANCELLED'));
  try {
    await waitForFile(marker);
    const pid = Number(await readFile(marker, 'utf8'));
    controller.abort();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    controller.abort();
    await rejected;
  }
});

test('a naturally exiting process cannot leave an MCP-like descendant running', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-descendant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'descendant');
  const descendant = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  await runProcess(process.execPath, ['-e', `
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['-e', process.argv[2], process.argv[1]], { stdio: 'ignore' });
    setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0); }, 10);
  `, marker, descendant], { timeout: 5000 });
  const pid = Number(await readFile(marker, 'utf8'));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      return;
    }
    await delay(20);
  }
  // Test cleanup in case an implementation regression leaves the child behind.
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
  assert.fail('The descendant remained alive after its parent completed');
});

test('missing executable and excessive output fail with redacted codes', async () => {
  await assert.rejects(runProcess('/nonexistent/replay-test-command', []), hasCode('CODEX_MISSING'));
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)'], { maxBytes: 100 }), hasCode('INTERNAL'));
});

test('stderr capture is bounded', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stderr.write("x".repeat(20000) + "END")']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr.length, 16000);
  assert.equal(result.stderr.endsWith('END'), true);
});
