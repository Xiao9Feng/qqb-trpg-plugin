// 跑团笔记本的持久层：一个团一个目录，线索 / NPC / 时间线 / 角色卡分开存。
//
// 为什么独立于 state/memory：三层记忆记的是「群友是什么人」= 现实人设；
// 跑团档案记的是「虚构世界里发生过什么」。混在一起会污染人设
// （鱼鱼会以为 NPC 真的存在、把 NPC 的谎话当成事实）。见 docs/guides/TRPG-DESIGN.md。
//
// 三条铁律，与 memory/store.mjs 同源（都是黑话库踩过的坑）：
//   1. 文件不存在 ≠ 读失败。前者返回空档，后者必须抛错——否则下一次保存会把原文件覆盖成空。
//   2. JSON 坏了就隔离成 .corrupt-<时间戳>，绝不静默清空。
//   3. 只写 tmp + rename（原子写）。
//
// 本模块不认识 DSH、不认识 QQ：只收「已经归一化好的数据」，方便离线单测。
import fs from 'node:fs';
import path from 'node:path';

export const TRPG_VERSION = 1;

// ── 上限（裁剪而不是拒绝：宁可丢最旧的，也不让文件无限长大） ────────────────
/** 一个团最多记多少条线索。 */
export const CLUES_MAX = 800;
/** 一个团最多记多少条时间线事件。 */
export const TIMELINE_MAX = 600;
/** 一个团最多记多少个 NPC。 */
export const NPCS_MAX = 200;
/** 单条线索/事件的最大字数（超了截断，不报错）。 */
export const TEXT_MAX = 400;
/** 角色卡改动日志条数。 */
export const CHAR_LOG_MAX = 200;
/** trpg_state 默认字数上限（设计稿要求 800 字内）。 */
export const SNAPSHOT_MAX = 800;

// ── 小工具 ──────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时区 ISO（带偏移），跟 memory 的 nowIso 一致。 */
export function nowIso(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return nowIso(new Date());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const base = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${base}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function clampText(value, max = TEXT_MAX) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 模组名 → 目录名。中文原样保留（Windows 支持），只清掉路径分隔符与保留字符。 */
export function slugify(name) {
  const raw = String(name ?? '').trim();
  if (!raw) throw new Error('模组名不能为空');
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const slug = cleaned.slice(0, 60);
  if (!slug) throw new Error('模组名里没有可用字符');
  return slug;
}

export function campaignDir(baseDir, slug) {
  return path.join(baseDir, slugify(slug));
}

// ── 原子读写 + 损坏隔离 ────────────────────────────────────────────────

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function quarantine(file, reason) {
  const target = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, target); } catch { /* 隔离失败就只能留着原文件，绝不删 */ }
  throw new Error(`${path.basename(file)} 读取失败（${reason}），已隔离到 ${path.basename(target)}；为避免覆盖真数据，本次操作中止`);
}

/**
 * 读 JSON。文件不存在 → 返回 empty()；文件坏了 → 隔离并抛错（绝不返回空档继续写）。
 */
export function readJson(file, empty) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return empty();
    throw error;
  }
  if (!stat.isFile()) return empty();
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return empty();
  try {
    return JSON.parse(text);
  } catch (error) {
    quarantine(file, error.message);
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// ── 团 ─────────────────────────────────────────────────────────────────

const emptyCampaign = () => ({
  version: TRPG_VERSION,
  slug: '',
  module: '',
  kp: '',
  players: [],
  startedAt: nowIso(),
  updatedAt: nowIso(),
  scene: { name: '', gameTime: '', note: '' },
  character: '',
});

export function listCampaigns(baseDir) {
  try {
    return fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => fs.existsSync(path.join(baseDir, name, 'campaign.json')));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** 当前团（state/trpg/current.json）。没设过就返回 null。 */
export function loadCurrent(baseDir) {
  const file = path.join(baseDir, 'current.json');
  const data = readJson(file, () => ({}));
  const slug = String(data?.slug ?? '').trim();
  return slug || null;
}

export function saveCurrent(baseDir, slug) {
  writeJson(path.join(baseDir, 'current.json'), { version: TRPG_VERSION, slug: slug ? slugify(slug) : null, at: nowIso() });
}

export function loadCampaign(baseDir, slug) {
  const dir = campaignDir(baseDir, slug);
  const data = readJson(path.join(dir, 'campaign.json'), () => null);
  if (!data) return null;
  return { ...emptyCampaign(), ...data };
}

export function saveCampaign(baseDir, campaign) {
  const next = { ...campaign, version: TRPG_VERSION, updatedAt: nowIso() };
  writeJson(path.join(campaignDir(baseDir, next.slug), 'campaign.json'), next);
  return next;
}

export function createCampaign(baseDir, { module, kp = '', players = [], character = '', scene = {} }) {
  const slug = slugify(module);
  const dir = campaignDir(baseDir, slug);
  ensureDir(dir);
  const existed = fs.existsSync(path.join(dir, 'campaign.json'));
  const prev = existed ? loadCampaign(baseDir, slug) : null;
  const campaign = {
    ...emptyCampaign(),
    ...(prev ?? {}),
    slug,
    module: String(module).trim(),
    // 合并：没传的字段保留原值，别用空字符串把已有信息洗掉
    kp: String(kp ?? '').trim() || (prev?.kp ?? ''),
    players: Array.isArray(players) && players.length
      ? players.map((p) => clampText(p, 40)).filter(Boolean)
      : (prev?.players ?? []),
    character: String(character ?? '').trim() || (prev?.character ?? ''),
    scene: {
      name: String(scene?.name ?? prev?.scene?.name ?? '').trim(),
      gameTime: String(scene?.gameTime ?? prev?.scene?.gameTime ?? '').trim(),
      note: clampText(scene?.note ?? prev?.scene?.note ?? ''),
    },
  };
  if (!existed) campaign.startedAt = nowIso();
  saveCampaign(baseDir, campaign);
  saveCurrent(baseDir, slug);
  return { campaign, existed, dir };
}

// ── 线索 ───────────────────────────────────────────────────────────────

const emptyClues = () => ({ version: TRPG_VERSION, nextId: 1, clues: [] });
const CLUE_STATUSES = ['active', 'verified', 'disproven', 'doubt'];
const CONFIDENCES = ['high', 'medium', 'low'];

function cluesFile(baseDir, slug) {
  return path.join(campaignDir(baseDir, slug), 'clues.json');
}

export function loadClues(baseDir, slug) {
  const data = readJson(cluesFile(baseDir, slug), emptyClues);
  if (!Array.isArray(data.clues)) data.clues = [];
  if (!Number.isInteger(data.nextId) || data.nextId < 1) data.nextId = data.clues.length + 1;
  return data;
}

/**
 * 追加一条线索。**强制 source**：不给来源就不知道是谁说的，等于把 NPC 的谎话存成事实。
 * 原文只追加不改写（改了就丢证据）；要推翻用 markClue。
 */
export function addClue(baseDir, slug, { text, source, foundAt = '', confidence = 'medium', related = [], verified = false }) {
  const body = clampText(text);
  if (!body) throw new Error('线索内容为空');
  const from = clampText(source, 80);
  if (!from) throw new Error('线索必须写 source（谁说的 / 在哪看到的），否则假线索会被当成事实');
  const conf = CONFIDENCES.includes(String(confidence)) ? String(confidence) : 'medium';
  const data = loadClues(baseDir, slug);
  const id = `clue-${String(data.nextId).padStart(3, '0')}`;
  const clue = {
    id,
    text: body,
    source: from,
    verified: Boolean(verified),
    confidence: conf,
    foundAt: clampText(foundAt, 80),
    related: Array.isArray(related) ? related.map((r) => clampText(r, 60)).filter(Boolean).slice(0, 8) : [],
    status: verified ? 'verified' : 'active',
    addedAt: nowIso(),
    marks: [],
  };
  data.clues.push(clue);
  data.nextId += 1;
  if (data.clues.length > CLUES_MAX) data.clues = data.clues.slice(-CLUES_MAX);
  writeJson(cluesFile(baseDir, slug), data);
  return clue;
}

export function findClues(baseDir, slug, { query = '', source = '', scene = '', status = '', limit = 20 } = {}) {
  const data = loadClues(baseDir, slug);
  const q = String(query ?? '').trim().toLowerCase();
  const src = String(source ?? '').trim().toLowerCase();
  const sc = String(scene ?? '').trim().toLowerCase();
  const st = String(status ?? '').trim().toLowerCase();
  const hits = data.clues.filter((c) => {
    if (st && String(c.status) !== st) return false;
    if (src && !String(c.source).toLowerCase().includes(src)) return false;
    if (sc && !String(c.foundAt).toLowerCase().includes(sc)) return false;
    if (!q) return true;
    const hay = [c.text, c.source, c.foundAt, ...(c.related ?? []), ...(c.marks ?? []).map((m) => m.note)].join('\n').toLowerCase();
    return hay.includes(q);
  });
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  return hits.slice(-n).reverse();
}

/** 标记线索：verified（证实）/ disproven（推翻）/ doubt（存疑）。原文保留，只加标记。 */
export function markClue(baseDir, slug, { id, status, note = '' }) {
  const want = String(status ?? '').trim().toLowerCase();
  if (!CLUE_STATUSES.includes(want)) throw new Error(`status 只能是 ${CLUE_STATUSES.join(' / ')}`);
  const data = loadClues(baseDir, slug);
  const clue = data.clues.find((c) => String(c.id).toLowerCase() === String(id ?? '').trim().toLowerCase());
  if (!clue) throw new Error(`找不到线索 ${id}`);
  clue.status = want;
  clue.verified = want === 'verified';
  clue.marks = Array.isArray(clue.marks) ? clue.marks : [];
  clue.marks.push({ status: want, note: clampText(note, 200), at: nowIso() });
  writeJson(cluesFile(baseDir, slug), data);
  return clue;
}

// ── 角色卡 ─────────────────────────────────────────────────────────────

function charFile(baseDir, slug, name) {
  return path.join(campaignDir(baseDir, slug), 'chars', `${slugify(name)}.json`);
}

export function listChars(baseDir, slug) {
  const dir = path.join(campaignDir(baseDir, slug), 'chars');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function loadChar(baseDir, slug, name) {
  const file = charFile(baseDir, slug, name);
  const data = readJson(file, () => null);
  if (!data) return null;
  return {
    version: TRPG_VERSION,
    name: data.name ?? String(name),
    occupation: data.occupation ?? '',
    attributes: data.attributes ?? {},
    derived: data.derived ?? {},
    skills: data.skills ?? {},
    items: data.items ?? [],
    current: { HP: 0, MP: 0, SAN: 0, MOV: 0, status: [], ...(data.current ?? {}) },
    log: data.log ?? [],
  };
}

export function saveChar(baseDir, slug, char) {
  writeJson(charFile(baseDir, slug, char.name), { ...char, version: TRPG_VERSION, updatedAt: nowIso() });
  return char;
}

/** 建/覆盖整张角色卡（车卡用）。已有卡则合并，不丢 current。 */
export function upsertChar(baseDir, slug, patch) {
  const name = String(patch?.name ?? '').trim();
  if (!name) throw new Error('角色名不能为空');
  const prev = loadChar(baseDir, slug, name) ?? {
    version: TRPG_VERSION, name, occupation: '', attributes: {}, derived: {},
    skills: {}, items: [], current: { HP: 0, MP: 0, SAN: 0, MOV: 0, status: [] }, log: [],
  };
  const next = {
    ...prev,
    occupation: patch.occupation ?? prev.occupation,
    attributes: { ...prev.attributes, ...(patch.attributes ?? {}) },
    derived: { ...prev.derived, ...(patch.derived ?? {}) },
    skills: { ...prev.skills, ...(patch.skills ?? {}) },
    items: Array.isArray(patch.items) ? patch.items.map((i) => clampText(i, 40)).filter(Boolean) : prev.items,
    current: { ...prev.current, ...(patch.current ?? {}) },
  };
  if (!patch.keepCurrent && patch.current === undefined && prev.current) {
    // 首次车卡时把 derived 里的 HP/MP/SAN 同步到 current，省得每次手动填
    next.current = {
      ...prev.current,
      HP: next.current.HP || next.derived.HP || 0,
      MP: next.current.MP || next.derived.MP || 0,
      SAN: next.current.SAN || next.derived.SAN || 0,
      MOV: next.current.MOV || next.derived.MOV || 0,
    };
  }
  return saveChar(baseDir, slug, next);
}

/**
 * 增量改当前值（HP/MP/SAN/MOV）。**必须给 reason**——跑团里掉 SAN 是有原因的，
 * 没原因的改动八成是模型自己算错了骰点。
 */
export function patchChar(baseDir, slug, { name, field, delta, value, reason = '', statusAdd = '', statusClear = '' }) {
  const f = String(field ?? '').toUpperCase();
  if (!['HP', 'MP', 'SAN', 'MOV'].includes(f)) throw new Error('field 只能是 HP / MP / SAN / MOV');
  const why = clampText(reason, 120);
  if (!why) throw new Error('必须写 reason（为什么变），防止模型自己解读骰点后乱改');
  const char = loadChar(baseDir, slug, name);
  if (!char) throw new Error(`找不到角色卡 ${name}`);
  const from = Number(char.current?.[f] ?? 0) || 0;
  const to = delta !== undefined && delta !== null && delta !== ''
    ? from + Number(delta)
    : Number(value ?? from);
  if (!Number.isFinite(to)) throw new Error('delta / value 必须是数字');
  char.current = char.current ?? {};
  char.current[f] = to;
  if (statusAdd) {
    char.current.status = Array.from(new Set([...(char.current.status ?? []), clampText(statusAdd, 40)]));
  }
  if (statusClear) {
    char.current.status = (char.current.status ?? []).filter((s) => s !== statusClear);
  }
  char.log = Array.isArray(char.log) ? char.log : [];
  char.log.push({ at: nowIso(), field: f, from, to, reason: why });
  if (char.log.length > CHAR_LOG_MAX) char.log = char.log.slice(-CHAR_LOG_MAX);
  return saveChar(baseDir, slug, char);
}

// ── 时间线 ─────────────────────────────────────────────────────────────

function timelineFile(baseDir, slug) {
  return path.join(campaignDir(baseDir, slug), 'timeline.json');
}

export function loadTimeline(baseDir, slug) {
  const data = readJson(timelineFile(baseDir, slug), () => ({ version: TRPG_VERSION, events: [] }));
  if (!Array.isArray(data.events)) data.events = [];
  return data;
}

/** 记一条事件。只记结论（KP 宣布了什么），不记骰点。 */
export function addTimeline(baseDir, slug, { text, gameTime = '' }) {
  const body = clampText(text);
  if (!body) throw new Error('事件内容为空');
  const data = loadTimeline(baseDir, slug);
  const event = { at: nowIso(), gameTime: clampText(gameTime, 40), text: body };
  data.events.push(event);
  if (data.events.length > TIMELINE_MAX) data.events = data.events.slice(-TIMELINE_MAX);
  writeJson(timelineFile(baseDir, slug), data);
  return event;
}

// ── NPC ────────────────────────────────────────────────────────────────

function npcFile(baseDir, slug) {
  return path.join(campaignDir(baseDir, slug), 'npcs.json');
}

export function loadNpcs(baseDir, slug) {
  const data = readJson(npcFile(baseDir, slug), () => ({ version: TRPG_VERSION, nextId: 1, npcs: [] }));
  if (!Array.isArray(data.npcs)) data.npcs = [];
  if (!Number.isInteger(data.nextId) || data.nextId < 1) data.nextId = data.npcs.length + 1;
  return data;
}

/** 记 NPC。同名视为同一人（累加笔记），不重复建卡。 */
export function addNpc(baseDir, slug, { name, attitude = '', toward = '', note = '' }) {
  const nm = clampText(name, 40);
  if (!nm) throw new Error('NPC 名字不能为空');
  const data = loadNpcs(baseDir, slug);
  let npc = data.npcs.find((n) => String(n.name) === nm);
  if (!npc) {
    npc = {
      id: `npc-${String(data.nextId).padStart(3, '0')}`,
      name: nm,
      attitude: clampText(attitude, 120),
      toward: [],
      notes: [],
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
    };
    data.npcs.push(npc);
    data.nextId += 1;
    if (data.npcs.length > NPCS_MAX) data.npcs = data.npcs.slice(-NPCS_MAX);
  }
  if (attitude) npc.attitude = clampText(attitude, 120);
  if (toward) {
    npc.toward = Array.isArray(npc.toward) ? npc.toward : [];
    npc.toward.push(clampText(toward, 120));
    if (npc.toward.length > 12) npc.toward = npc.toward.slice(-12);
  }
  if (note) {
    npc.notes = Array.isArray(npc.notes) ? npc.notes : [];
    npc.notes.push({ text: clampText(note), at: nowIso() });
    if (npc.notes.length > 30) npc.notes = npc.notes.slice(-30);
  }
  npc.lastSeenAt = nowIso();
  writeJson(npcFile(baseDir, slug), data);
  return npc;
}

export function getNpc(baseDir, slug, name) {
  const q = String(name ?? '').trim();
  const data = loadNpcs(baseDir, slug);
  if (!q) return data.npcs;
  return data.npcs.filter((n) => String(n.name).includes(q) || String(n.id) === q);
}

// ── 重启回现场（★ 全插件最关键的输出） ────────────────────────────────

/**
 * 把当前团压成一段能直接贴进提示词的现场快照。
 * 顺序按「读一眼就知道演到哪」排：场景 → 我是谁 → 线索（按可信度） → 最近事件 → 未解决。
 */
export function buildSnapshot(baseDir, slug, { maxChars = SNAPSHOT_MAX } = {}) {
  const campaign = loadCampaign(baseDir, slug);
  if (!campaign) throw new Error(`没有这个团：${slug}`);
  const clues = loadClues(baseDir, slug).clues;
  const timeline = loadTimeline(baseDir, slug).events;
  const char = campaign.character ? loadChar(baseDir, slug, campaign.character) : null;

  const lines = [];
  const sceneName = campaign.scene?.name || '（未记录当前场景）';
  const gameTime = campaign.scene?.gameTime ? `${campaign.scene.gameTime} · ` : '';
  lines.push(`【当前】${gameTime}${sceneName}${campaign.kp ? `（KP: ${campaign.kp}）` : ''}`);

  if (char) {
    const st = (char.current?.status ?? []).join('、');
    const cur = char.current ?? {};
    lines.push(`【我是】${char.name}${char.occupation ? `（${char.occupation}）` : ''} HP ${cur.HP ?? '?'}/${char.derived?.HP ?? '?'} SAN ${cur.SAN ?? '?'}/${char.derived?.SAN ?? '?'}${st ? ` 状态：${st}` : ''}`);
  } else if (campaign.character) {
    lines.push(`【我是】${campaign.character}（角色卡未建）`);
  }

  const verified = clues.filter((c) => c.status === 'verified');
  const active = clues.filter((c) => c.status === 'active');
  const doubt = clues.filter((c) => c.status === 'doubt');
  const disproven = clues.filter((c) => c.status === 'disproven');
  lines.push(`【线索】证实 ${verified.length} / 待验 ${active.length} / 存疑 ${doubt.length} / 推翻 ${disproven.length}`);
  const pick = [...verified.slice(-3), ...doubt.slice(-2), ...active.slice(-4)];
  for (const c of pick) {
    const tag = c.status === 'verified' ? '已证实' : c.status === 'doubt' ? '存疑' : '未验证';
    lines.push(`  · [${tag}] ${c.text}（来源：${c.source}${c.foundAt ? ` · ${c.foundAt}` : ''}）`);
  }

  if (timeline.length) {
    lines.push('【最近发生】');
    for (const e of timeline.slice(-3)) {
      const when = e.gameTime ? `${e.gameTime} ` : String(e.at ?? '').slice(11, 16);
      lines.push(`  · ${when}${e.text}`);
    }
  }

  const open = campaign.scene?.note ? [campaign.scene.note] : [];
  if (open.length) lines.push(`【未解决】${open.join(' / ')}`);

  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 20)}\n…（快照超长已截断）`;
  return text;
}

export { CLUE_STATUSES, CONFIDENCES };
