// 手动起一个真桥，供**跨语言**端到端验证用：让 Swift 侧真的往桥里投递。
//
// 为什么单独一个脚本：桥的自检套件里，客户端是用假 ctx 驱动的；
// 而「Swift 的 URLSession 能不能穿过沙箱/ATS 真的把请求送到 Node 桥」
// 这个问题只有让真二进制跑一遍才算证过。
//
// 用法（两条命令，桥要在前一条就位）：
//   node test/serve-bridge.mjs 47311 &
//   swift/.build/DSHNotch --self-test-jump | grep 投递
// 期望看到「投递调用正常返回（通=true）」；桥不在时是 false（降级，正常）。
// 完事记得关：kill %1  或  pkill -f serve-bridge
import { createIsolatedModule } from './isolated-module.mjs';

const fixture = createIsolatedModule();
const mod = await fixture.importModule();
const bridge = await mod.startBridge({ port: Number(process.argv[2] || 47311), log: (m) => console.log('[bridge] ' + m) });
if (!bridge) { console.error('桥起不来'); process.exit(1); }
console.log('[bridge] READY port=' + bridge.port);
// 不自动退出：等外部来打
process.on('SIGTERM', async () => { await bridge.close(); process.exit(0); });
