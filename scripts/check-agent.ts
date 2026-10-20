// Explicit synthetic smoke test. Calls the real Codex CLI; does NOT prove real Bilibili search.
import assert from 'node:assert/strict';
import { ToolGate, type BilibiliSource } from '../server/upstream';
import { runCodexSelection } from '../server/codex';
import { errorCode } from '../server/domain';

const bvid = 'BV1Q541167Qg';
const fixture: BilibiliSource = {
  credentials: async () => ({ configured: true, logged_in: true }),
  search: async () => [{ bvid, title: '2024测试杯 10月1日决赛 北队 vs 南队 完整回放',
    description: '合成测试数据。比赛于2024年10月1日举行，第一局和第二局均完整收录。',
    author: '测试赛事频道', published_at: '2024-10-02', duration_seconds: 4000 }],
  metadata: async () => ({ bvid, title: '2024测试杯 10月1日决赛 北队 vs 南队 完整回放',
    description: '合成测试数据，完整比赛只有两局，每局一个完整分P；末尾是采访，不属于比赛。',
    pages: [{ page: 1, cid: 101, title: '第一局 完整回放', duration: 1800 },
      { page: 2, cid: 102, title: '第二局 完整回放', duration: 1800 },
      { page: 3, cid: 103, title: '赛后采访', duration: 400 }] }),
  close: async () => {},
};
console.log('合成联调：真实调用 Codex CLI + 两个受限工具；不访问 B 站、不进入观看页面。');
const gate = new ToolGate(fixture, AbortSignal.timeout(180_000));
try {
  const segments = await runCodexSelection('2024测试杯 2024年10月1日 决赛 北队 vs 南队 完整比赛', gate, AbortSignal.timeout(180_000));
  assert.deepEqual(segments, [{ bvid, cid: 101, page: 1 }, { bvid, cid: 102, page: 2 }]);
  console.log(`合成联调通过：真实 CLI 调用了搜索与元数据，输出已核验的比赛片段并排除采访。搜索调用 ${gate.evidence.searches} 次。`);
} catch (e) {
  console.log(`合成联调未通过：${errorCode(e)}。实际搜索调用 ${gate.evidence.searches} 次，元数据调用 ${gate.evidence.metadata.size} 次。`);
  process.exitCode = 1;
}
