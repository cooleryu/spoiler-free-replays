import test from 'node:test';
import assert from 'node:assert/strict';
import { restrictedArgs } from '../server/codex';
import { validateSelection, ReplayError } from '../server/domain';

test('Codex configuration disables inherited MCPs using supported literal path syntax', () => {
  const args = restrictedArgs(['one-tool', 'two_tool'], '/tmp/replay task', '/tmp/schema.json');
  assert.ok(args.includes('mcp_servers.one-tool.enabled=false'));
  assert.ok(args.includes('mcp_servers.two_tool.enabled=false'));
  assert.ok(args.includes('mcp_servers.replay_local.enabled=true'));
  assert.ok(args.includes('features.code_mode_host=true')); // Required for MCP discovery on the tested CLI.
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('features.multi_agent=false'));
  assert.ok(args.includes('features.hooks=false'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('/tmp/replay task'));
  assert.ok(!args.includes('--model'));
  assert.ok(!args.some(arg => arg.includes('bypass')));
  assert.equal(args.at(-1), '-');
  assert.throws(() => restrictedArgs(['a.b'], '/tmp/task', '/tmp/schema'), (e: unknown) => e instanceof ReplayError && e.code === 'TOOL_UNAVAILABLE');
});

test('insufficient input may be ambiguous without inventing a search or a network failure', () => {
  assert.throws(() => validateSelection({ status: 'ambiguous', segments: [] }, {
    searches: 0, successfulSearches: 0, found: new Set(), metadata: new Map(),
  }), (e: unknown) => e instanceof ReplayError && e.code === 'AMBIGUOUS');
});
