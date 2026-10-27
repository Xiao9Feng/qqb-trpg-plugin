// 跑团笔记本存储层的离线单测：不碰 QQ、不碰 DSH，只在临时目录里跑。
// 用法：node scripts/test-trpg-store.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addClue,
  addNpc,
  addTimeline,
  buildSnapshot,
  createCampaign,
  findClues,
  getNpc,
  listCampaigns,
  loadCampaign,
  loadChar,
  loadCurrent,
  markClue,
  patchChar,
  readJson,
  slugify,
  SNAPSHOT_MAX,
  upsertChar,
} from '../src/trpg/store.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-test-'));
let passed = 0;

function ok(label) {
  passed += 1;
  console.log(`  OK  ${label}`);
}

try {
  // 1) 空库：没有团 = 空列表，不是报错
  assert.deepEqual(listCampaigns(base), []);
  assert.equal(loadCurrent(base), null);
  ok('空库读取不报错');

  // 2) 开团
  const { campaign, existed } = createCampaign(base, {
    module: '常暗', kp: 'KP老王', players: ['阿蓝'], character: '鱼鱼',
    scene: { name: '第一夜 · 酒馆', gameTime: '第一夜 21:40', note: '地下室的钥匙在哪' },
  });
  assert.equal(existed, false);
  assert.equal(campaign.slug, '常暗');
  assert.equal(loadCurrent(base), '常暗');
  assert.deepEqual(listCampaigns(base), ['常暗']);
  ok('开团 + current 指向');

  // 3) 同名再开 = 合并，不清空
  const again = createCampaign(base, { module: '常暗', kp: 'KP老王' });
  assert.equal(again.existed, true);
  assert.equal(again.campaign.scene.name, '第一夜 · 酒馆', '重新开团不该清掉场景');
  ok('同名团合并而非重置');

  // 4) 线索必须带 source
  assert.throws(() => addClue(base, '常暗', { text: '地下室有箱子' }), /source/);
  const c1 = addClue(base, '常暗', { text: '酒保说地下室那晚有人搬箱子', source: 'NPC:酒保约翰', foundAt: '第一夜 · 酒馆', confidence: 'medium' });
  assert.equal(c1.id, 'clue-001');
  assert.equal(c1.verified, false);
  assert.equal(c1.status, 'active');
  const c2 = addClue(base, '常暗', { text: '门牌上写着三楼封锁', source: '场景:废弃医院', foundAt: '第二夜 · 三楼', verified: true });
  assert.equal(c2.id, 'clue-002');
  assert.equal(c2.status, 'verified');
  ok('线索强制 source + 自动编号 + verified 影响状态');

  // 5) 查询与标记（原文不改，只加标记）
  assert.equal(findClues(base, '常暗', { query: '箱子' }).length, 1);
  assert.equal(findClues(base, '常暗', { source: '酒保' }).length, 1);
  assert.equal(findClues(base, '常暗', { status: 'verified' }).length, 1);
  const marked = markClue(base, '常暗', { id: 'clue-001', status: 'disproven', note: 'KP: 箱子里其实是标本瓶' });
  assert.equal(marked.status, 'disproven');
  assert.equal(marked.text, '酒保说地下室那晚有人搬箱子', '原文必须保留');
  assert.equal(marked.marks.length, 1);
  assert.equal(findClues(base, '常暗', { status: 'proven' }).length, 0);
  ok('线索查询 + 推翻保留原文');

  // 6) 角色卡：车卡 + 增量 + 必须给 reason
  const char = upsertChar(base, '常暗', {
    name: '鱼鱼', occupation: '记者',
    attributes: { DEX: 70, INT: 75 }, derived: { HP: 11, SAN: 55 },
    skills: { 侦查: 65 }, items: ['相机', '手电筒'],
  });
  assert.equal(char.current.HP, 11, '车卡时 derived 应同步到 current');
  assert.equal(char.current.SAN, 55);
  assert.throws(() => patchChar(base, '常暗', { name: '鱼鱼', field: 'SAN', delta: -3 }), /reason/);
  const hurt = patchChar(base, '常暗', { name: '鱼鱼', field: 'SAN', delta: -3, reason: 'KP: 你看到那东西，掉 3 点' });
  assert.equal(hurt.current.SAN, 52);
  assert.equal(hurt.log.length, 1);
  const worse = patchChar(base, '常暗', { name: '鱼鱼', field: 'HP', delta: -2, reason: 'KP: 被划伤', statusAdd: '左臂擦伤' });
  assert.equal(worse.current.HP, 9);
  assert.deepEqual(worse.current.status, ['左臂擦伤']);
  assert.equal(loadChar(base, '常暗', '鱼鱼').current.SAN, 52, '落盘要能读回');
  ok('角色卡增量改动 + 强制 reason + 状态');

  // 7) 时间线 / NPC
  addTimeline(base, '常暗', { text: '我们在楼梯口遇到管理员，他拒绝让我们上去', gameTime: '第二夜 20:14' });
  addTimeline(base, '常暗', { text: '我在墙上发现了划痕', gameTime: '第二夜 20:40' });
  addNpc(base, '常暗', { name: '管理员', attitude: '警惕', toward: '讨厌酒保', note: '右手一直在抖' });
  addNpc(base, '常暗', { name: '管理员', note: '钥匙串上有一把生锈的' });
  const npcs = getNpc(base, '常暗', '管理');
  assert.equal(npcs.length, 1, '同名 NPC 应合并');
  assert.equal(npcs[0].notes.length, 2);
  ok('时间线 + NPC 同名累加');

  // 8) 现场快照：含关键信息且不超字数
  const snap = buildSnapshot(base, '常暗');
  assert.match(snap, /【当前】第一夜 21:40 · 第一夜 · 酒馆（KP: KP老王）/);
  assert.match(snap, /【我是】鱼鱼（记者） HP 9\/11 SAN 52\/55 状态：左臂擦伤/);
  assert.match(snap, /【线索】证实 1 \/ 待验 0 \/ 存疑 0 \/ 推翻 1/);
  assert.match(snap, /【最近发生】/);
  assert.match(snap, /【未解决】地下室的钥匙在哪/);
  assert.ok(snap.length <= SNAPSHOT_MAX, `快照 ${snap.length} 字超了 ${SNAPSHOT_MAX}`);
  ok(`回现场快照（${snap.length} 字）`);

  // 9) 损坏隔离：坏了就改名隔离并抛错，绝不返回空库
  const broken = path.join(base, 'broken-case');
  fs.mkdirSync(broken, { recursive: true });
  const badFile = path.join(broken, 'clues.json');
  fs.writeFileSync(badFile, '{ 这不是 JSON', 'utf8');
  assert.throws(() => readJson(badFile, () => ({})), /隔离/);
  assert.equal(fs.existsSync(badFile), false, '坏文件应被移走');
  const quarantined = fs.readdirSync(broken).filter((f) => f.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, '应留下 .corrupt-* 备份');
  ok('坏 JSON 隔离而非静默清空');

  // 10) 路径清洗
  assert.equal(slugify('常暗 / 第二章'), '常暗-第二章');
  assert.throws(() => slugify('   '), /不能为空/);
  ok('模组名 → 目录名');

  console.log(`\n全部通过：${passed} 项`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
