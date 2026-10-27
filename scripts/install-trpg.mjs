#!/usr/bin/env node
// 跑团笔记本（CoC · PL 模式）· 自安装脚本（幂等）
//
// 用法：在 qq-bridge 仓库根目录执行
//   node scripts/install-trpg.mjs                      # 装
//   node scripts/install-trpg.mjs --check              # 只自检锚点，不改任何文件
//   node scripts/install-trpg.mjs --group 123456789    # 顺便把这个群加进跑团白名单
//
// 它会做 7 件事：
//   1) 给 src/bridge.js 加「跑团模式」（按会话切 preset，共 4 处改动）
//   2) 给 config.example.json 加 trpg 段
//   3) 复制 dsh/agent-presets/qq-chat-trpg/ 三个 preset 文件（若包里带了）
//   4) 给 scripts/setup-dsh.mjs 注册 mcp-trpg
//   5) 给 plugins/qq-agent-presets/qq-tool-restrict.mjs 放行 mcp__trpg__
//   6) 给 scripts/build-agent-preset-patches.mjs 的 PRESETS 加 qq-chat-trpg
//   7) 给 plugins/qq-agent-presets/package.json 的 bundle patch 列表加 trpg
//
// 前提：qq-bridge v0.2.1-r1（锚点按这个版本写；版本不同会「锚点不存在」直接停，不会改坏文件）。
// 为什么要脚本：跑团模式的接线散在 12000 行的 bridge.js 里，手工改必错。
// 每一步都可重复运行；改完先做 node --check，不通过自动回滚。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');
const groupArgIdx = process.argv.indexOf('--group');
const GROUP = groupArgIdx > 0 ? String(process.argv[groupArgIdx + 1] ?? '').trim() : '';

const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const BACKUP = path.join(ROOT, 'src', 'bridge.js.bak-before-trpg');

if (!fs.existsSync(BRIDGE)) {
  console.error(`找不到 ${BRIDGE}——请在 qq-bridge 仓库根目录运行本脚本`);
  process.exit(1);
}

const done = [];
const skipped = [];
function say(msg) { console.log(msg); }

// ── bridge.js 的 4 处改动 ────────────────────────────────────────────────
const BRIDGE_BLOCKS = [
  {
    "label": "常量：TRPG_MODE_FILE",
    "oldText": "const MEMORY_SESSION_FILE = path.join(MEMORY_DIR, 'digest-session.json');\r\nconst TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');\r\n",
    "newText": "const MEMORY_SESSION_FILE = path.join(MEMORY_DIR, 'digest-session.json');\r\n// 跑团模式：按会话覆盖 preset（哪个群开了跑团，就换成 qq-chat-trpg）。\nconst TRPG_MODE_FILE = path.join(STATE_DIR, 'trpg-mode.json');\r\nconst TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');\r\n"
  },
  {
    "label": "跑团模式状态与函数（含 trpgPresetFor / trpgCommandOf / applyTrpgCommand）",
    "oldText": "\n  function memoryEnabled() {\n    return cfg.memory?.enabled !== false;\n  }\n\n  if (memoryEnabled()) {\n    try {\n      memoryShort = loadShort(MEMORY_SHORT_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });\n      memoryLong = loadLong(MEMORY_LONG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });\n      const persona = loadPersona(MEMORY_DIR, { onCorrupt: (message) => log(`⚠️ ${message}`) });\n      memoryPersona = persona.text;\n      memoryPersonaExisted = persona.existed;\n      log(`记忆已加载：短期 ${Object.keys(memoryShort.days).length} 天，长期 ${Object.keys(memoryLong.people).length} 人`\n        + (memoryPersonaExisted ? '，人设叠加层已就绪' : '，人设叠加层还是空白模板'));\n    } catch (error) {\n      memoryWritable = false;\n      log(`⚠️ 记忆库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);\n    }\n  }\n\n  function saveMemoryShort() {\n    if (!memoryWritable || !memoryEnabled()) return;\n    try { saveShort(MEMORY_SHORT_FILE, memoryShort); } catch (error) { log('保存短期记忆失败:', error?.message ?? error); }\n  }\n\n  function saveMemoryLong() {\n    if (!memoryWritable || !memoryEnabled()) return;\n    try { saveLong(MEMORY_LONG_FILE, memoryLong); } catch (error) { log('保存长期记忆失败:', error?.message ?? error); }\n  }\n\n  function saveMemoryPersona() {\n    if (!memoryWritable || !memoryEnabled()) return;\n    try { savePersona(MEMORY_DIR, memoryPersona); } catch (error) { log('保存人设叠加层失败:', error?.message ?? error); }\n  }\n\n  /** 每天跑一次衰减就够了：它按「30 天没提到」判断，跑得再勤也不会有新结论。 */\n  function maybeDecayMemory() {\n    if (!memoryEnabled()) return;\n    const now = Date.now();\n    if (now - memoryLastDecayAt < 6 * 60 * 60 * 1000) return;\n    memoryLastDecayAt = now;\n    const keepDays = Math.max(3, resolveContextConfig(cfg.memory?.context ?? {}).shortDays);\n    const dropped = pruneShort(memoryShort, { now: new Date(now), keepDays });\n    const decayed = decayLong(memoryLong, { now: new Date(now), idleDays: Math.max(7, Number(cfg.memory?.idleDays) || 30) });\n    if (dropped.length || decayed.archived || decayed.weakened) {\n      log(`记忆整理：清理 ${dropped.length} 天旧短期记录，淡化 ${decayed.weakened} 条，归档 ${decayed.archived} 条`);\n      saveMemoryShort();\n      saveMemoryLong();\n    }\n  }\r\n\r\n  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────\r\n",
    "newText": "\n  // ── 跑团模式（按会话切 preset）─────────────────────────────────────────\n  //\n  // 为什么用「覆盖 preset」而不是「动态加工具」：MCP 工具清单是 DSH 启动时读的，\n  // 运行期加不了。但 preset 是按会话定的，换 preset 就能换整套工具面和规则，\n  // 而桥接的 sessionPolicy 已经把 preset 算进「会话身份」——preset 一变，\n  // 旧会话自动作废、下次唤醒重建，我们不用手写重建逻辑。\n  //\n  // 代价：开/关跑团模式会丢当前会话上下文。跑团刚开局本来就要新上下文，\n  // 所以这个代价是零；中途切换才会丢，README 里要写清楚。\n  let trpgMode = (() => {\n    try {\n      const raw = readJsonSafe(TRPG_MODE_FILE, {});\n      const active = raw && typeof raw === 'object' ? raw.active : null;\n      return active && typeof active === 'object' && !Array.isArray(active) ? active : {};\n    } catch (error) {\n      log('跑团模式状态读取失败，按未开启处理:', error?.message ?? error);\n      return {};\n    }\n  })();\n\n  function saveTrpgMode() {\n    try { atomicWriteJson(TRPG_MODE_FILE, { active: trpgMode }); }\n    catch (error) { log('保存跑团模式状态失败:', error?.message ?? error); }\n  }\n\n  /** 这个会话开着跑团模式吗？开着就返回该用的 preset 名。 */\n  function trpgPresetFor(key) {\n    if (!memoryEnabled()) return null; // 总开关关掉时跑团模式也一起停（避免只改了一半）\n    if (cfg.trpg?.enabled === false) return null;\n    const entry = trpgMode[key];\n    if (!entry) return null;\n    return String(entry.preset || cfg.trpg?.preset || 'qq-chat-trpg');\n  }\n\n  /** 从一句话里认出「打开/关闭跑团模式」。容忍「鱼鱼」前缀，句子太长就不认。 */\n  function trpgCommandOf(text) {\n    const raw = String(text ?? '').trim();\n    if (!raw || raw.length > 32) return null;\n    // 容忍 @ 前缀、称呼、冒号、空白：「@鱼鱼 鱼鱼：打开跑团模式啦」也想认\n    const t = raw\n      .replace(/@\\S+/gu, '')\n      .trim()\n      .replace(/^(鱼鱼|大肥鱼|小鲸鱼|小蓝鱼)/u, '')\n      .replace(/[\\s:：,，、]+/gu, '')\n      .trim();\n    if (/^(打开|开启|进入|开始|启动|开).{0,3}(跑团|团)(模式)?[吧啊呀啦喵呢哈啰喽~～!！。.]*$/u.test(t)) return 'on';\n    if (/^(退出|关闭|结束|停止|关|退).{0,3}(跑团|团)(模式)?[吧啊呀啦喵呢哈啰喽~～!！。.]*$/u.test(t)) return 'off';\n    return null;\n  }\n\n  /**\n   * 执行开关。返回要发到群里的提示；返回 null 表示「当没看见」（别的群不该知道有这功能）。\n   */\n  function applyTrpgCommand({ key, kind, id, isOwner, action }) {\n    if (cfg.trpg?.enabled === false) return null;\n    const allowed = (Array.isArray(cfg.trpg?.allowedGroups) ? cfg.trpg.allowedGroups : []).map(String);\n    if (kind !== 'group' || !allowed.includes(String(id))) return null;\n    if (cfg.trpg?.ownerOnly !== false && !isOwner) {\n      return '跑团模式得让姐姐来开喵。';\n    }\n    const preset = String(cfg.trpg?.preset || 'qq-chat-trpg');\n    if (action === 'on') {\n      if (trpgMode[key]) return '跑团模式已经开着了喵。';\n      trpgMode[key] = { preset, at: nowIso(), by: cfg.ownerQQ ?? null };\n      saveTrpgMode();\n      retireSession(key); // 让新 preset 立刻生效（下条消息重建会话）\n      log(`跑团模式已开启：${key}（preset=${preset}）`);\n      return '跑团模式开启喵。之后我会用跑团的格式说话：\"\" 是台词，# 是动作，（）是出戏。开局前跟我说一句模组名和我的角色喵。';\n    }\n    if (!trpgMode[key]) return '跑团模式本来就没开喵。';\n    delete trpgMode[key];\n    saveTrpgMode();\n    retireSession(key);\n    log(`跑团模式已关闭：${key}`);\n    return '跑团模式关掉了，恢复正常聊天喵。';\n  }\n\n  function memoryEnabled() {\n    return cfg.memory?.enabled !== false;\n  }\n\n  if (memoryEnabled()) {\n    try {\n      memoryShort = loadShort(MEMORY_SHORT_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });\n      memoryLong = loadLong(MEMORY_LONG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });\n      const persona = loadPersona(MEMORY_DIR, { onCorrupt: (message) => log(`⚠️ ${message}`) });\n      memoryPersona = persona.text;\n      memoryPersonaExisted = persona.existed;\n      log(`记忆已加载：短期 ${Object.keys(memoryShort.days).length} 天，长期 ${Object.keys(memoryLong.people).length} 人`\n        + (memoryPersonaExisted ? '，人设叠加层已就绪' : '，人设叠加层还是空白模板'));\n    } catch (error) {\n      memoryWritable = false;\n      log(`⚠️ 记忆库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);\n    }\n  }\n\n  function saveMemoryShort() {\n    if (!memoryWritable || !memoryEnabled()) return;\n    try { saveShort(MEMORY_SHORT_FILE, memoryShort); } catch (error) { log('保存短期记忆失败:', error?.message ?? error); }\n  }\n\n  function saveMemoryLong() {\n    if (!memoryWritable || !memoryEnabled()) return;\n    try { saveLong(MEMORY_LONG_FILE, memoryLong); } catch (error) { log('保存长期记忆失败:', error?.message ?? error); }\n  }\n\n  function saveMemoryPersona() {\n    if (!memoryWritable || !memoryEnabled()) return;\n    try { savePersona(MEMORY_DIR, memoryPersona); } catch (error) { log('保存人设叠加层失败:', error?.message ?? error); }\n  }\n\n  /** 每天跑一次衰减就够了：它按「30 天没提到」判断，跑得再勤也不会有新结论。 */\n  function maybeDecayMemory() {\n    if (!memoryEnabled()) return;\n    const now = Date.now();\n    if (now - memoryLastDecayAt < 6 * 60 * 60 * 1000) return;\n    memoryLastDecayAt = now;\n    const keepDays = Math.max(3, resolveContextConfig(cfg.memory?.context ?? {}).shortDays);\n    const dropped = pruneShort(memoryShort, { now: new Date(now), keepDays });\n    const decayed = decayLong(memoryLong, { now: new Date(now), idleDays: Math.max(7, Number(cfg.memory?.idleDays) || 30) });\n    if (dropped.length || decayed.archived || decayed.weakened) {\n      log(`记忆整理：清理 ${dropped.length} 天旧短期记录，淡化 ${decayed.weakened} 条，归档 ${decayed.archived} 条`);\n      saveMemoryShort();\n      saveMemoryLong();\n    }\n  }\r\n\r\n  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────\r\n"
  },
  {
    "label": "modePreset：该会话优先返回跑团 preset",
    "oldText": "    }\r\n    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。\r\n",
    "newText": "    }\r\n    // 跑团模式：这个会话被单独指定了 preset。必须在普通分支之前判断，\n    // 且同样 strict——拿不到 qq-chat-trpg 就返回 undefined 让上层拒绝建会话，\n    // 绝不能让 DSH 拿默认 preset（带本地工具）顶上。\n    const trpgPreset = trpgPresetFor(key);\n    if (trpgPreset) return resolvePresetName(trpgPreset, { strict: true }) || undefined;\n    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。\r\n"
  },
  {
    "label": "消息入口：识别「打开/关闭跑团模式」",
    "oldText": "\r\n    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）\r\n",
    "newText": "\r\n    // 跑团模式开关：自然语言触发（这样群友也看得见），但只认允许开团的群 + 管理员。\n    const trpgAction = trpgCommandOf(plainContent);\n    if (/跑团/.test(String(plainContent ?? ''))) {\n      log(`[trpg] 收到疑似指令「${plainContent}」→ ${trpgAction ?? '未匹配'}`);\n    }\n    if (trpgAction) {\n      const reply = applyTrpgCommand({ key, kind, id, isOwner, action: trpgAction });\n      if (reply) {\n        await sendToQQ(key, reply);\n        return;\n      }\n      // reply 为 null = 这个群不开放跑团模式，当普通聊天继续往下走\n    }\n\n    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）\r\n"
  }
];

let src = fs.readFileSync(BRIDGE, 'utf8');
const hadBom = src.charCodeAt(0) === 0xfeff;
if (hadBom) src = src.slice(1);

if (src.includes('TRPG_MODE_FILE')) {
  skipped.push('bridge.js 的跑团模式接线（已存在）');
} else {
  for (const block of BRIDGE_BLOCKS) {
    const at = src.indexOf(block.oldText);
    if (at < 0) {
      console.error(`\n✗ 锚点不存在：${block.label}`);
      console.error('  （你的 qq-bridge 版本可能不是 v0.2.1-r1；本次没有修改任何文件）');
      process.exit(1);
    }
    if (src.indexOf(block.oldText, at + 1) >= 0) {
      console.error(`\n✗ 锚点不唯一：${block.label}（文件被别的补丁动过同一段）`);
      process.exit(1);
    }
    src = src.slice(0, at) + block.newText + src.slice(at + block.oldText.length);
    done.push(`bridge.js · ${block.label}`);
  }
}

// ── config.example.json 加 trpg 段 ───────────────────────────────────────
function patchConfigExample() {
  if (!fs.existsSync(EXAMPLE)) { skipped.push('config.example.json 不存在'); return; }
  let ex = fs.readFileSync(EXAMPLE, 'utf8');
  const bom = ex.charCodeAt(0) === 0xfeff;
  if (bom) ex = ex.slice(1);
  if (/^ {2}"trpg"\s*:\s*\{/m.test(ex)) { skipped.push('config.example.json 的 trpg 段（已存在）'); return; }
  const eol = ex.includes('\r\n') ? '\r\n' : '\n';
  const block = [
    '  "trpg": {',
    '    "enabled": true,',
    '    "allowedGroups": [],',
    '    "preset": "qq-chat-trpg",',
    '    "ownerOnly": true',
    '  },',
  ].join(eol);
  // 锚点不带换行前缀，免得 CRLF/LF 不一致时找不到
  const anchor = (() => {
    const at = ex.indexOf('"social": {');
    return at;
  })();
  if (anchor < 0) { skipped.push('config.example.json 里找不到 social 段（trpg 段未加）'); return; }
  ex = ex.slice(0, anchor) + block + eol + ex.slice(anchor);
  JSON.parse(ex); // 校验
  if (!CHECK_ONLY) fs.writeFileSync(EXAMPLE, (bom ? '\uFEFF' : '') + ex, 'utf8');
  done.push('config.example.json 加 trpg 段');
}

// ── 其余四处接线（都在别的文件里，逐行锚点） ──────────────────────────────
function patchTextFile(relPath, edits) {
  const file = path.join(ROOT, relPath);
  if (!fs.existsSync(file)) { skipped.push(`${relPath} 不存在`); return; }
  let text = fs.readFileSync(file, 'utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  for (const edit of edits) {
    if (text.includes(edit.marker)) { skipped.push(`${relPath} · ${edit.label}（已存在）`); continue; }
    const at = text.indexOf(edit.oldText);
    if (at < 0) { skipped.push(`${relPath} · ${edit.label}（锚点不存在，跳过）`); continue; }
    text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
    done.push(`${relPath} · ${edit.label}`);
  }
  if (!CHECK_ONLY) fs.writeFileSync(file, (bom ? '\uFEFF' : '') + text, 'utf8');
}



// ── 执行 ─────────────────────────────────────────────────────────────────

// 写回 bridge.js + 语法检查
const bridgeChanged = done.some((d) => d.startsWith('bridge.js'));
if (bridgeChanged) {
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, (hadBom ? '\uFEFF' : '') + fs.readFileSync(BRIDGE, 'utf8'), 'utf8');
  fs.writeFileSync(BRIDGE, (hadBom ? '\uFEFF' : '') + src, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', BRIDGE], { stdio: 'pipe' });
  } catch (error) {
    fs.copyFileSync(BACKUP, BRIDGE);
    console.error('✗ 改完语法检查不通过，已自动回滚。请把下面的报错发出来：');
    console.error(String(error.stderr ?? error.message).slice(0, 800));
    process.exit(1);
  }
}

patchConfigExample();

// preset 文件（包里有就拷，没有就提示）
const presetSrc = path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-trpg');
const presetPkg = path.join(__dirname, '..', 'preset-src', 'qq-chat-trpg');
if (!CHECK_ONLY && !fs.existsSync(presetSrc) && fs.existsSync(presetPkg)) {
  fs.mkdirSync(presetSrc, { recursive: true });
  for (const f of fs.readdirSync(presetPkg)) {
    fs.copyFileSync(path.join(presetPkg, f), path.join(presetSrc, f));
    done.push(`dsh/agent-presets/qq-chat-trpg/${f}`);
  }
} else if (fs.existsSync(presetSrc)) {
  skipped.push('dsh/agent-presets/qq-chat-trpg（已存在）');
}

patchTextFile('scripts/setup-dsh.mjs', [
  {
    label: 'MANAGED_MCP_IDS 加 mcp-trpg（已装记忆）',
    marker: "'mcp-trpg']",
    oldText: "'mcp-web-search-safe', 'mcp-memory']",
    newText: "'mcp-web-search-safe', 'mcp-memory', 'mcp-trpg']",
  },
  {
    label: 'MANAGED_MCP_IDS 加 mcp-trpg（未装记忆）',
    marker: "'mcp-trpg']",
    oldText: "'mcp-snowluma-host', 'mcp-web-search-safe']",
    newText: "'mcp-snowluma-host', 'mcp-web-search-safe', 'mcp-trpg']",
  },
  {
    label: 'mcpEntries 加 trpg 条目（已装记忆）',
    marker: "'mcp-trpg':",
    oldText: "'mcp-memory': { serverName: 'memory', script: path.join(REPO_ROOT, 'src', 'memory', 'mcp-server.mjs') },",
    newText: "'mcp-memory': { serverName: 'memory', script: path.join(REPO_ROOT, 'src', 'memory', 'mcp-server.mjs') },\n"
      + "    // 跑团笔记本：读写都归这个插件（桥接不碰 state/trpg），所以没有双写冲突。\n"
      + "    'mcp-trpg': { serverName: 'trpg', script: path.join(REPO_ROOT, 'src', 'trpg', 'mcp-server.mjs') },",
  },
  {
    label: 'mcpEntries 加 trpg 条目（未装记忆）',
    marker: "'mcp-trpg':",
    oldText: "'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },",
    newText: "'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },\n"
      + "    // 跑团笔记本：读写都归这个插件（桥接不碰 state/trpg），所以没有双写冲突。\n"
      + "    'mcp-trpg': { serverName: 'trpg', script: path.join(REPO_ROOT, 'src', 'trpg', 'mcp-server.mjs') },",
  },
]);

patchTextFile('plugins/qq-agent-presets/qq-tool-restrict.mjs', [
  {
    label: 'SAFE_PREFIXES 放行 mcp__trpg__',
    marker: "'mcp__trpg__'",
    oldText: "  'mcp__web-search-safe__',",
    newText: "  'mcp__web-search-safe__',\n  // 跑团笔记本（src/trpg）：只读写 state/trpg 下的档案，没有本地执行能力。\n  'mcp__trpg__',",
  },
]);

patchTextFile('scripts/build-agent-preset-patches.mjs', [
  {
    label: 'PRESETS 加 qq-chat-trpg',
    marker: "'qq-chat-trpg'",
    oldText: "export const PRESETS = ['qq-chat', 'qq-chat-v2'];",
    newText: "export const PRESETS = ['qq-chat', 'qq-chat-v2', 'qq-chat-trpg'];",
  },
]);

patchTextFile('plugins/qq-agent-presets/package.json', [
  {
    label: 'bundle patch 加 trpg',
    marker: 'qq-chat-trpg.patch.yml',
    oldText: '        "./presets/qq-chat-v2.patch.yml"',
    newText: '        "./presets/qq-chat-v2.patch.yml",\n        "./presets/qq-chat-trpg.patch.yml"',
  },
]);

if (CHECK_ONLY) {
  say('\n锚点自检结果：');
  say('  可改动：' + (done.length ? done.map((d) => '\n    · ' + d).join('') : '（无）'));
  if (skipped.length) say('  已存在/跳过：' + skipped.map((d) => '\n    · ' + d).join(''));
  say('\n（--check 没有修改任何文件）');
  process.exit(0);
}

// ── config.json（可选：加了 --group 才动，且只加白名单 + trpg 段）────────
if (GROUP) {
  const cfgFile = path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfgFile)) { say('（没有 config.json，跳过群号写入）'); }
  else {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
    cfg.allow ??= { private: [], groups: [] };
    cfg.allow.groups = [...new Set([...(cfg.allow.groups ?? []).map(String), GROUP])];
    cfg.trpg = {
      enabled: true,
      allowedGroups: [...new Set([...(cfg.trpg?.allowedGroups ?? []).map(String), GROUP])],
      preset: 'qq-chat-trpg',
      ownerOnly: true,
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    done.push(`config.json：群 ${GROUP} 加进白名单 + 跑团白名单`);
  }
}

say('\n✓ 跑团插件安装完成：');
for (const d of done) say('  · ' + d);
if (skipped.length) {
  say('\n已存在 / 跳过：');
  for (const s of skipped) say('  · ' + s);
}

say('\n接下来（顺序别换）：');
say('  1) node scripts/build-agent-preset-patches.mjs      # 生成 qq-chat-trpg.patch.yml');
say('  2) node scripts/setup-dsh.mjs                        # 注册 mcp-trpg + 装 preset');
say('  3) 重启 DSH（新 MCP 与 preset 要重启才生效）');
say('  4) 重启桥接');
say('  5) 在跑团群里（owner 号）说「打开跑团模式」，会话会自动重建并带上 trpg 工具');
say('\n提示：切换/退出跑团模式会重建会话——之前的上下文会丢，这是设计如此（preset 算会话身份）。');
