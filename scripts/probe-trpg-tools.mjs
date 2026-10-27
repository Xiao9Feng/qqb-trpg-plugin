// 端到端验证「跑团工具面」：用 qq-chat-trpg preset 建会话，要求 agent 真的调用 mcp__trpg__ 工具。
//
// 为什么需要它：MCP 注册成功（进程起来了）≠ 工具在会话里可见可调用。
// qq-tool-restrict 的 guard 白名单要是漏了 mcp__trpg__，工具会被静默拒绝，
// 表现成「鱼鱼从来不记线索」——这种失效不会报错，只能用真实调用验证。
//
// 用法：node scripts/probe-trpg-tools.mjs
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TRPG_DIR = path.join(ROOT, 'state', 'trpg');
const SCRATCH = '探针测试';

const cookie = probeCookie();
const rpc = probeRpc(cookie);
const PRESET = 'qq-chat-trpg';
const dir = probeWorkspaceDir('trpg-tools');

const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) { console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`); process.exit(2); }
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);

const sm = await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } });
console.log('selectModel ->', sm.ok ? 'ok' : `FAIL ${sm.error.code}`);

const socket = probeMuxSocket(cookie);
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
const toolResults = [];
let text = '';

const PROMPT = [
  '这是一次工具自检，不要扮演角色、不要发 QQ 消息。请严格按顺序做三件事：',
  `1. 调用 mcp__trpg__trpg_new，module 传「${SCRATCH}」，kp 传「探针」，character 传「探针员」，sceneName 传「测试房间」。`,
  '2. 调用 mcp__trpg__trpg_clue_add，text 传「墙上有暗红色的字」，source 传「KP:探针」。',
  '3. 调用 mcp__trpg__trpg_state，把返回内容原样贴出来。',
  '全部做完只回复：完成',
].join('\n');

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 150_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: PROMPT }] },
      });
      if (!p.ok) console.error('prompt 失败:', p.error?.code, p.error?.message);
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
    if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name ?? e.data?.toolName, args: e.data?.arguments ?? e.data?.args });
    if (e.type === 'tool/result') toolResults.push({ name: e.data?.name ?? e.data?.toolName, isError: e.data?.isError ?? e.data?.error !== undefined });
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n结果: ${why}`);
console.log('tool/call:', JSON.stringify(toolCalls.map((t) => t.name)));
console.log('tool/result 错误数:', toolResults.filter((t) => t.isError).length);

const trpgCalls = toolCalls.filter((t) => String(t.name ?? '').startsWith('mcp__trpg__'));
const errors = toolResults.filter((t) => t.isError);
const onDisk = fs.existsSync(path.join(TRPG_DIR, SCRATCH, 'clues.json'))

console.log('\n判定:');
console.log(`  调用了跑团工具        : ${trpgCalls.length >= 3 ? '✅' : `❌ 只有 ${trpgCalls.length} 次`}`);
console.log(`  工具执行无错误        : ${errors.length === 0 ? '✅' : `❌ ${errors.length} 次报错`}`);
console.log(`  档案真的落盘          : ${onDisk ? '✅ state/trpg/' + SCRATCH : '❌ 没找到 clues.json'}`);
if (onDisk) {
  const clues = JSON.parse(fs.readFileSync(path.join(TRPG_DIR, SCRATCH, 'clues.json'), 'utf8'));
  const c = clues.clues?.[0];
  console.log(`  线索内容              : ${c ? `${c.id} ${c.text}（来源 ${c.source}）` : '（空）'}`);
}
const stateCalled = toolCalls.some((t) => String(t.name ?? '').includes('trpg_state'))
const stateText = stateCalled ? '✅ trpg_state 已调用（快照在工具结果里）' : '❌ 没调用 trpg_state'
console.log(`  回现场工具            : ${stateText}`)

// 清理：删掉探针会话的临时团
try { fs.rmSync(path.join(TRPG_DIR, SCRATCH), { recursive: true, force: true }); } catch { /* ignore */ }
try { await rpc('session/archive', { request: { sessionId } }); } catch { /* ignore */ }

const fail = trpgCalls.length < 3 || errors.length > 0 || !onDisk;
process.exit(fail ? 1 : 0);
