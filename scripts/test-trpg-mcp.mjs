// 跑团 MCP 工具面的冒烟测试：真的把 server 拉起来、列工具、按回合顺序调一遍。
// 跑法：node scripts/test-trpg-mcp.mjs
//
// 为什么单独测：MCP 是唯一「模型会主动调用」的入口。它坏了不会报错，
// 只会表现成「鱼鱼从来不记线索」——这种静默失效最难发现。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
let passed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error(`✗ ${label}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-mcp-'));
const NODE = process.env.QQB_TEST_NODE || 'C:\\Program Files\\nodejs\\node.exe';
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(ELECTRON|npm_|VSCODE|CHATBOX|NODE_OPTIONS)/i.test(k))
);
cleanEnv.QQB_TRPG_DIR = tmp;

const transport = new StdioClientTransport({
  command: NODE,
  args: [path.join(ROOT, 'src', 'trpg', 'mcp-server.mjs')],
  cwd: ROOT,
  env: cleanEnv,
  stderr: 'inherit',
});

const client = new Client({ name: 'trpg-mcp-test', version: '0.0.1' });
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content?.[0]?.text ?? '', isError: Boolean(res.isError) };
};

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    'trpg_new', 'trpg_state', 'trpg_scene_set',
    'trpg_clue_add', 'trpg_clue_find', 'trpg_clue_mark',
    'trpg_char_new', 'trpg_char_show', 'trpg_char_patch',
    'trpg_timeline_add', 'trpg_npc_add', 'trpg_npc_get', 'trpg_stats',
  ];
  for (const name of expected) ok(names.includes(name), `注册了 ${name}`);
  ok(tools.every((t) => t.description && t.description.length > 10), '每个工具都有描述');
  const schemaSize = JSON.stringify(tools).length;
  console.log(`  （工具面 schema 约 ${Math.round(schemaSize / 4)} tokens）`);

  // 没有团时：给提示，不报死
  const noCampaign = await call('trpg_state');
  ok(noCampaign.text.includes('trpg_new'), '没开团时 trpg_state 提示先开团');

  // 开团
  const created = await call('trpg_new', {
    module: '常暗', kp: 'KP老王', character: '鱼鱼', sceneName: '第一夜 · 酒馆', gameTime: '第一夜 21:40',
    note: '地下室的钥匙在哪',
  });
  ok(!created.isError && created.text.includes('常暗'), 'trpg_new 建团成功');

  // 车卡
  const charNew = await call('trpg_char_new', {
    name: '鱼鱼', occupation: '记者', attributes: { DEX: 70 }, derived: { HP: 11, SAN: 55 }, items: ['相机'],
  });
  ok(!charNew.isError && charNew.text.includes('SAN 55'), 'trpg_char_new 车卡并把 derived 同步到 current');

  // 线索：无 source 必须被拒
  const noSource = await call('trpg_clue_add', { text: '地下室有箱子' });
  ok(noSource.isError && noSource.text.includes('source'), '缺 source 时拒绝记线索');

  // 线索：正常记
  const clue = await call('trpg_clue_add', { text: '酒保说地下室那晚有人搬箱子', source: 'NPC:酒保约翰', foundAt: '第一夜 · 酒馆' });
  ok(!clue.isError && clue.text.includes('clue-001'), 'trpg_clue_add 自动编号');

  // 查询
  const found = await call('trpg_clue_find', { query: '箱子' });
  ok(found.text.includes('未验证') && found.text.includes('酒保'), 'trpg_clue_find 带出可信度');

  // 标记
  const marked = await call('trpg_clue_mark', { id: 'clue-001', status: 'disproven', note: 'KP: 那是标本瓶' });
  ok(!marked.isError && marked.text.includes('disproven'), 'trpg_clue_mark 可用');

  // 改 SAN：无 reason 必须被拒
  const noReason = await call('trpg_char_patch', { field: 'SAN', delta: -3 });
  ok(noReason.isError && noReason.text.includes('reason'), '缺 reason 时拒绝改 SAN');

  const san = await call('trpg_char_patch', { field: 'SAN', delta: -3, reason: 'KP: 你看到那东西', statusAdd: '手在抖' });
  ok(!san.isError && san.text.includes('SAN'), 'trpg_char_patch 改 SAN 成功');

  // 时间线 / NPC
  const tl = await call('trpg_timeline_add', { text: '我们在楼梯口遇到管理员', gameTime: '第二夜 20:14' });
  ok(!tl.isError, 'trpg_timeline_add 可用');
  const npc = await call('trpg_npc_add', { name: '管理员', attitude: '警惕', note: '右手一直在抖' });
  ok(!npc.isError && npc.text.includes('管理员'), 'trpg_npc_add 可用');
  const npcGet = await call('trpg_npc_get', { name: '管理' });
  ok(npcGet.text.includes('右手一直在抖'), 'trpg_npc_get 读回细节');

  // 场景推进
  const scene = await call('trpg_scene_set', { sceneName: '第二夜 · 废弃医院三楼', gameTime: '第二夜 20:40', note: '谁在夜里搬东西' });
  ok(!scene.isError && scene.text.includes('废弃医院三楼'), 'trpg_scene_set 可用');

  // 回现场：最关键的输出
  const snap = await call('trpg_state');
  ok(snap.text.includes('【当前】'), 'trpg_state 有【当前】');
  ok(snap.text.includes('HP 11/11') && snap.text.includes('SAN 52/55'), 'trpg_state 带角色当前值');
  ok(snap.text.includes('【线索】') && snap.text.includes('推翻 1'), 'trpg_state 带线索分布');
  ok(snap.text.includes('【最近发生】'), 'trpg_state 带最近事件');
  ok(snap.text.includes('【未解决】'), 'trpg_state 带未解决疑问');
  ok(snap.text.length <= 800, `快照 ${snap.text.length} 字未超 800`);
  console.log('\n--- trpg_state 实际输出 ---\n' + snap.text + '\n---');

  // 多团必须要求指定
  await call('trpg_new', { module: '雨夜宅子' });
  const ambiguous = await call('trpg_state', {});
  ok(!ambiguous.isError, '当前团仍能定位（current.json 生效）');

  const stats = await call('trpg_stats');
  ok(stats.text.includes('clues'), 'trpg_stats 返回可解析 JSON');
} catch (error) {
  failed += 1;
  console.error(`✗ MCP 连接/调用异常：${error?.message ?? error}`);
} finally {
  try { await client.close(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n跑团 MCP 工具面测试：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
