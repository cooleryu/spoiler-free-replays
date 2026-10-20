// Reuse upstream authentication only; do not enter its optional ASR installation flow.
import { setupAuthentication } from '@xzxzzx/bilibili-mcp/dist/cli.js';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('请在自己的交互终端运行 npm run bilibili:setup，然后本人扫码确认。');
  process.exitCode = 1;
} else {
  console.log('使用已安装的 bilibili-mcp 1.14.2 进行登录。凭据由上游保存在 ~/.bilibili-mcp/config.json。');
  console.log('不会安装语音转录模型。请不要把二维码、登录链接或 Cookie 发到聊天里。');
  try { if (!await setupAuthentication()) process.exitCode = 1; }
  catch { console.error('登录未完成，请检查网络后重试。'); process.exitCode = 1; }
}
