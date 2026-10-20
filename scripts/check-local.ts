import { MatchCatalog } from '../server/catalog';
import { errorCode, ReplayError } from '../server/domain';

const catalog = new MatchCatalog();
const signal = AbortSignal.timeout(45_000);
try {
  const result = await catalog.refresh(signal);
  if (result.warning) throw new ReplayError('SOURCE_UNAVAILABLE');
  console.log('公开比赛列表：已获取，无需登录');
  console.log(JSON.stringify(result, null, 2));
  if (result.matches[0]) {
    await catalog.watch(result.matches[0].id, signal);
    console.log('首场比赛：已核对所属账号与正片分 P；此检查不代表实际播放验证');
  }
} catch (error) {
  console.error(`公开来源检查失败：${errorCode(error)}`);
  process.exitCode = 1;
}
