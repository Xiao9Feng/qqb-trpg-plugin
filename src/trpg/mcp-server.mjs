// 跑团笔记本的 MCP 工具面（stdio），给 DSH 里的 agent（鱼鱼）当 PL 用。
//
// 与 state/memory 的关系：完全独立。
//   三层记忆 = 「群友是什么人」（现实人设）
//   跑团档案 = 「虚构世界里发生过什么」（线索 / NPC / 时间线 / 角色卡）
// 混在一起会污染人设，也会把 NPC 的谎话存成事实。见 docs/guides/TRPG-DESIGN.md。
//
// 为什么这里读写都走 MCP（不像记忆那样写入归桥接）：
//   跑团数据只有本插件碰，桥接完全不碰，不存在双写覆盖问题。
//
// 工具清单（12 个）：
//   trpg_new / trpg_state / trpg_scene_set
//   trpg_clue_add / trpg_clue_find / trpg_clue_mark
//   trpg_char_new / trpg_char_show / trpg_char_patch
//   trpg_timeline_add / trpg_npc_add / trpg_npc_get
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  addClue,
  addNpc,
  addTimeline,
  buildSnapshot,
  createCampaign,
  findClues,
  getNpc,
  listCampaigns,
  listChars,
  loadCampaign,
  loadChar,
  loadClues,
  loadCurrent,
  loadTimeline,
  markClue,
  patchChar,
  saveCampaign,
  saveCurrent,
  upsertChar,
} from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
// 测试时可用 QQB_TRPG_DIR 指到临时目录，避免污染真实档案。
const TRPG_DIR = process.env.QQB_TRPG_DIR
  ? path.resolve(process.env.QQB_TRPG_DIR)
  : path.join(ROOT, 'state', 'trpg');

const ok = (text) => ({ content: [{ type: 'text', text: String(text) }] });
const fail = (message) => ({ content: [{ type: 'text', text: `✗ ${message}` }], isError: true });

/** 统一包一层：工具出错要变成「可读的一句话」，而不是把异常抛给模型。 */
function wrap(fn) {
  return async (args) => {
    try { return await fn(args ?? {}); } catch (error) { return fail(error?.message ?? String(error)); }
  };
}

/**
 * 定位要操作的团：显式参数 > current.json > 唯一存在的团。
 * 都找不到时抛出可读提示（不要瞎猜一个团出来）。
 */
function resolveSlug(explicit) {
  const want = String(explicit ?? '').trim();
  if (want) {
    if (!loadCampaign(TRPG_DIR, want)) throw new Error(`没有这个团：${want}`);
    return want;
  }
  const current = loadCurrent(TRPG_DIR);
  if (current && loadCampaign(TRPG_DIR, current)) return current;
  const all = listCampaigns(TRPG_DIR);
  if (all.length === 1) return all[0];
  if (all.length === 0) throw new Error('还没有任何团。先用 trpg_new 开团（或确认模组名）。');
  throw new Error(`有多个团，请指定 campaign：${all.join(' / ')}`);
}

const campaignArg = z.string().optional().describe('团（模组名）。省略则用当前团。');

const server = new McpServer({ name: 'qq-trpg', version: '0.1.0' });

server.tool(
  'trpg_new',
  '开团/加入团：登记模组名、KP、玩家、自己演的角色，并把它设为当前团。已经存在同名团时会合并而非清空。',
  {
    module: z.string().describe('模组名，如「常暗」「雨夜宅子」'),
    kp: z.string().optional().describe('KP 是谁（真人，通常是群友昵称）'),
    players: z.array(z.string()).optional().describe('同一车里的其他玩家'),
    character: z.string().optional().describe('你自己演的角色名（PL 卡）'),
    sceneName: z.string().optional().describe('开场场景，如「第一夜 · 酒馆」'),
    gameTime: z.string().optional().describe('游戏内时间，如「第一夜 21:40」'),
    note: z.string().optional().describe('还没解决的疑问（会出现在 trpg_state 的【未解决】）'),
  },
  wrap(async ({ module, kp, players, character, sceneName, gameTime, note }) => {
    const { campaign, existed } = createCampaign(TRPG_DIR, {
      module,
      kp,
      players,
      character,
      scene: { name: sceneName, gameTime, note },
    });
    return ok(`${existed ? '已合并到现有团' : '开团成功'}：${campaign.module}`
      + `${campaign.kp ? `（KP: ${campaign.kp}）` : ''}${campaign.character ? ` ｜ 我演 ${campaign.character}` : ''}`
      + `\n目录：state/trpg/${campaign.slug}/`);
  })
);

server.tool(
  'trpg_state',
  '★重启/换会话后一键回现场：当前场景、我的 HP/SAN、线索可信度分布与关键几条、最近发生的事。每次被唤醒先调它再演。',
  { campaign: campaignArg },
  wrap(async ({ campaign }) => {
    const slug = resolveSlug(campaign);
    return ok(buildSnapshot(TRPG_DIR, slug));
  })
);

server.tool(
  'trpg_scene_set',
  '更新当前场景 / 游戏内时间 / 未解决的疑问（KP 说「你们进了地下室」「天亮了」时用）。只传要改的字段。',
  {
    campaign: campaignArg,
    sceneName: z.string().optional().describe('当前场景'),
    gameTime: z.string().optional().describe('游戏内时间'),
    note: z.string().optional().describe('未解决的问题，传空字符串可清空'),
  },
  wrap(async ({ campaign, sceneName, gameTime, note }) => {
    const slug = resolveSlug(campaign);
    const cur = loadCampaign(TRPG_DIR, slug);
    const scene = {
      name: sceneName ?? cur.scene?.name ?? '',
      gameTime: gameTime ?? cur.scene?.gameTime ?? '',
      note: note ?? cur.scene?.note ?? '',
    };
    saveCampaign(TRPG_DIR, { ...cur, scene });
    return ok(`已更新场景：${scene.gameTime ? `${scene.gameTime} · ` : ''}${scene.name || '（空）'}`
      + `${scene.note ? `\n未解决：${scene.note}` : ''}`);
  })
);

server.tool(
  'trpg_clue_add',
  '记一条线索。**必须填 source**（谁说的 / 在哪看到的）——NPC 会撒谎，来源和事实必须分开存。默认未验证。',
  {
    campaign: campaignArg,
    text: z.string().describe('线索内容（只写看到/听到的事实，不要写推断）'),
    source: z.string().describe('来源：NPC 名字 / 文件 / 场景，如「NPC:酒保约翰」'),
    foundAt: z.string().optional().describe('在哪发现的，如「第一夜 · 酒馆」'),
    confidence: z.enum(['high', 'medium', 'low']).optional().describe('你主观的可信度，默认 medium'),
    related: z.array(z.string()).optional().describe('关联的 NPC / 场景'),
    verified: z.boolean().optional().describe('KP 明确证实过就传 true，否则别传'),
  },
  wrap(async ({ campaign, ...rest }) => {
    const slug = resolveSlug(campaign);
    const clue = addClue(TRPG_DIR, slug, rest);
    return ok(`已记下 ${clue.id}（${clue.verified ? '已证实' : '未验证'}）：${clue.text}　来源：${clue.source}`);
  })
);

server.tool(
  'trpg_clue_find',
  '按关键词 / 来源 / 场景 / 状态查线索，返回时带可信度状态。想确认「这条到底是谁说的、证没证实」时用。',
  {
    campaign: campaignArg,
    query: z.string().optional().describe('关键词'),
    source: z.string().optional().describe('按来源过滤，如「酒保」'),
    scene: z.string().optional().describe('按发现地点过滤'),
    status: z.enum(['active', 'verified', 'disproven', 'doubt']).optional().describe('按状态过滤'),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回几条，默认 20'),
  },
  wrap(async ({ campaign, ...rest }) => {
    const slug = resolveSlug(campaign);
    const hits = findClues(TRPG_DIR, slug, rest);
    if (!hits.length) return ok('没有匹配的线索。别硬编——真没有就是没有，可以问 KP 或换个关键词。');
    const tag = { verified: '已证实', active: '未验证', disproven: '已推翻', doubt: '存疑' };
    return ok(hits.map((c) => {
      const marks = (c.marks ?? []).slice(-1).map((m) => m.note).filter(Boolean);
      return `${c.id} [${tag[c.status] ?? c.status}] ${c.text}\n    来源：${c.source}${c.foundAt ? ` · ${c.foundAt}` : ''}（可信度 ${c.confidence}）`
        + `${marks.length ? `\n    备注：${marks[0]}` : ''}`;
    }).join('\n'));
  })
);

server.tool(
  'trpg_clue_mark',
  '标记线索：verified 证实 / disproven 推翻 / doubt 存疑。原文不改，只加标记和历史。KP 说了新证据时用。',
  {
    campaign: campaignArg,
    id: z.string().describe('线索 id，如 clue-003'),
    status: z.enum(['verified', 'disproven', 'doubt']).describe('新状态'),
    note: z.string().optional().describe('为什么这么判（KP 说了什么）'),
  },
  wrap(async ({ campaign, id, status, note }) => {
    const slug = resolveSlug(campaign);
    const clue = markClue(TRPG_DIR, slug, { id, status, note });
    return ok(`${clue.id} 已标记为 ${clue.status}：${clue.text}`);
  })
);

server.tool(
  'trpg_char_new',
  '车卡/更新角色卡：属性、技能、物品、派生值（HP/MP/SAN/MOV）。同角色再次调用是合并，不会清空当前伤势。',
  {
    campaign: campaignArg,
    name: z.string().describe('角色名'),
    occupation: z.string().optional(),
    attributes: z.record(z.string(), z.number()).optional().describe('STR/CON/SIZ/DEX/APP/INT/POW/EDU'),
    derived: z.record(z.string(), z.number()).optional().describe('HP/MP/SAN/MOV 上限'),
    skills: z.record(z.string(), z.number()).optional(),
    items: z.array(z.string()).optional(),
  },
  wrap(async ({ campaign, ...patch }) => {
    const slug = resolveSlug(campaign);
    const char = upsertChar(TRPG_DIR, slug, patch);
    return ok(`角色卡已存：${char.name}${char.occupation ? `（${char.occupation}）` : ''}`
      + ` HP ${char.current.HP}/${char.derived.HP ?? '?'} SAN ${char.current.SAN}/${char.derived.SAN ?? '?'}`);
  })
);

server.tool(
  'trpg_char_show',
  '读自己的角色卡（属性/技能/物品/当前 HP・MP・SAN・状态）。不确定自己还剩多少 SAN 时先看这里。',
  {
    campaign: campaignArg,
    name: z.string().optional().describe('角色名，省略则用团里登记的那个'),
  },
  wrap(async ({ campaign, name }) => {
    const slug = resolveSlug(campaign);
    const cur = loadCampaign(TRPG_DIR, slug);
    const who = String(name ?? cur.character ?? '').trim();
    if (!who) throw new Error('没指定角色名，团里也没登记角色');
    const char = loadChar(TRPG_DIR, slug, who);
    if (!char) throw new Error(`还没有 ${who} 的角色卡（可用 trpg_char_new 车卡），现有：${listChars(TRPG_DIR, slug).join(' / ') || '无'}`);
    const cur2 = char.current ?? {};
    const lines = [
      `${char.name}${char.occupation ? `（${char.occupation}）` : ''}`,
      `当前：HP ${cur2.HP}/${char.derived.HP ?? '?'}　MP ${cur2.MP}/${char.derived.MP ?? '?'}　SAN ${cur2.SAN}/${char.derived.SAN ?? '?'}　MOV ${cur2.MOV ?? '?'}`,
      (cur2.status ?? []).length ? `状态：${cur2.status.join('、')}` : '',
      Object.keys(char.attributes ?? {}).length ? `属性：${Object.entries(char.attributes).map(([k, v]) => `${k} ${v}`).join(' ')}` : '',
      Object.keys(char.skills ?? {}).length ? `技能：${Object.entries(char.skills).map(([k, v]) => `${k} ${v}`).join(' ')}` : '',
      (char.items ?? []).length ? `物品：${char.items.join('、')}` : '',
      (char.log ?? []).length ? `最近变动：${char.log.slice(-3).map((l) => `${l.field} ${l.from}→${l.to}（${l.reason}）`).join('；')}` : '',
    ].filter(Boolean);
    return ok(lines.join('\n'));
  })
);

server.tool(
  'trpg_char_patch',
  '增量改当前值（HP/MP/SAN/MOV），**必须写 reason**。只在 KP 宣布结果后调用，不要自己按骰点算。',
  {
    campaign: campaignArg,
    name: z.string().optional().describe('角色名，省略用团里登记的'),
    field: z.enum(['HP', 'MP', 'SAN', 'MOV']).describe('改哪一项'),
    delta: z.number().optional().describe('增减量，如 -3'),
    value: z.number().optional().describe('直接设成某个值（和 delta 二选一）'),
    reason: z.string().describe('为什么变（KP 说了什么），如「KP: 你看到那东西，掉 3 点 SAN」'),
    statusAdd: z.string().optional().describe('加一个状态，如「左臂擦伤」'),
    statusClear: z.string().optional().describe('去掉一个状态'),
  },
  wrap(async ({ campaign, ...rest }) => {
    const slug = resolveSlug(campaign);
    const cur = loadCampaign(TRPG_DIR, slug);
    const who = String(rest.name ?? cur.character ?? '').trim();
    if (!who) throw new Error('没指定角色名，团里也没登记角色');
    const char = patchChar(TRPG_DIR, slug, { ...rest, name: who });
    return ok(`${char.name} ${rest.field} → ${char.current[rest.field]}`
      + `（${rest.reason}）${(char.current.status ?? []).length ? `　状态：${char.current.status.join('、')}` : ''}`);
  })
);

server.tool(
  'trpg_timeline_add',
  '记一条事件（只记结论：KP 宣布发生了什么、转到哪了），不记骰点。',
  {
    campaign: campaignArg,
    text: z.string().describe('发生了什么（一句话）'),
    gameTime: z.string().optional().describe('游戏内时间，如「第二夜 20:31」'),
  },
  wrap(async ({ campaign, ...rest }) => {
    const slug = resolveSlug(campaign);
    const e = addTimeline(TRPG_DIR, slug, rest);
    return ok(`已记入时间线${e.gameTime ? `（${e.gameTime}）` : ''}：${e.text}`);
  })
);

server.tool(
  'trpg_npc_add',
  '记/更新一个 NPC：他的名字、对你的态度、他讨厌谁、你观察到的细节。同名会累加笔记。',
  {
    campaign: campaignArg,
    name: z.string().describe('NPC 名字'),
    attitude: z.string().optional().describe('他对你的态度'),
    toward: z.string().optional().describe('他对别人的态度，如「讨厌管理员」'),
    note: z.string().optional().describe('你观察到的细节（可多次累加）'),
  },
  wrap(async ({ campaign, ...rest }) => {
    const slug = resolveSlug(campaign);
    const npc = addNpc(TRPG_DIR, slug, rest);
    return ok(`NPC 已记：${npc.name}（${npc.id}）${npc.attitude ? ` 态度：${npc.attitude}` : ''}`);
  })
);

server.tool(
  'trpg_npc_get',
  '查 NPC：态度、对别人的态度、你记过的所有细节。要判断「这人可不可信」时用。',
  {
    campaign: campaignArg,
    name: z.string().optional().describe('名字片段；省略则列出全部 NPC'),
  },
  wrap(async ({ campaign, name }) => {
    const slug = resolveSlug(campaign);
    const hits = getNpc(TRPG_DIR, slug, name);
    if (!hits.length) return ok('没记过这个 NPC。');
    return ok(hits.map((n) => `${n.name}（${n.id}）${n.attitude ? `\n  态度：${n.attitude}` : ''}`
      + `${(n.toward ?? []).length ? `\n  对他人：${n.toward.join('；')}` : ''}`
      + `${(n.notes ?? []).length ? `\n  细节：${n.notes.map((x) => x.text).join('；')}` : ''}`).join('\n'));
  })
);

// 诊断用：看一眼这个团存了些什么（怀疑「它怎么不记得线索」时先查这里）
server.tool(
  'trpg_stats',
  '看一眼跑团档案的规模（团数、线索数、角色卡、事件数），排查「为什么它不记得」时用。',
  { campaign: campaignArg },
  wrap(async ({ campaign }) => {
    const slug = resolveSlug(campaign);
    const clues = loadClues(TRPG_DIR, slug).clues;
    const timeline = loadTimeline(TRPG_DIR, slug).events;
    return ok(JSON.stringify({
      dir: path.join(TRPG_DIR, slug),
      campaigns: listCampaigns(TRPG_DIR),
      clues: clues.length,
      byStatus: clues.reduce((acc, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc; }, {}),
      chars: listChars(TRPG_DIR, slug),
      timeline: timeline.length,
    }, null, 2));
  })
);

await server.connect(new StdioServerTransport());
