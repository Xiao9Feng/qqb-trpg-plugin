# 跑团笔记本（CoC · PL 模式）· qq-bridge 插件

> 给 QQ 里的 AI 加一本**跨会话、跨重启都不会忘**的跑团笔记本：线索卡 / 角色卡 / 时间线 / NPC。
> AI 只当 **PL（玩家）**，KP 是真人；骰子用群里现成的骰娘，本插件不掷骰、不解读骰点。
>
> 依赖：**qq-bridge v0.2.1-r1**（接线锚点按这个版本写）。建议先装 [`三层记忆插件`](https://github.com/Xiao9Feng/qqb-memory-plugin)（本插件是它的衍生），**不是必须**。

---

## 它解决什么

| 没有它 | 有它 |
|---|---|
| 跑团聊 200 条上下文爆了，重启后忘了自己查到什么 | `trpg_state` 一次输出：当前场景 + HP/SAN + 线索分布 + 最近事件 + 未解决，**≤800 字** |
| NPC 的谎话被当成事实，推理越推越歪 | 每条线索强制 `source`（谁说的），默认「未验证」，可标「证实/推翻/存疑」 |
| 掉 SAN 全凭印象，回头发现记错了 | 改 HP/MP/SAN **必须写 reason**，改动带日志 |
| 切个场景就忘了时间线 | `trpg_timeline_add` 只记结论，不记骰点 |

---

## 包里有什么

```
install-trpg.ps1                    一键安装器（Windows）
scripts/install-trpg.mjs            接线器：改 bridge.js / setup-dsh / preset 注册
scripts/test-trpg-store.mjs         存储层单测（10 项）
scripts/test-trpg-mcp.mjs           工具面冒烟（35 项）
scripts/probe-trpg-tools.mjs        端到端探针：真的用跑团 preset 建会话调工具
src/trpg/store.mjs                  持久层：团 / 线索 / 角色卡 / 时间线 / NPC + 现场快照
src/trpg/mcp-server.mjs             MCP 工具面（13 个工具）
preset-src/qq-chat-trpg/            跑团专用 preset（发言格式 + 回合流程 + 工具用法）
docs/TRPG-DESIGN.md                 设计稿与实现记录（含为什么这么设计）
```

---

## 前置条件

| 项 | 要求 | 怎么查 |
|---|---|---|
| Node.js | >= 22.13 | `node -v` |
| qq-bridge | **v0.2.1-r1** | `node -p "require('./package.json').version"` |
| DSH | 已装并能跑 qq-bridge（本插件用 DSH 的 MCP + agent preset 机制） | 桥接控制台能看到 DSH 已就绪 |
| [三层记忆（可选）](https://github.com/Xiao9Feng/qqb-memory-plugin) | 装了更好（跑团时人设/群友信息也在） | `src\memory\` 是否存在 |

---

## 先自检（30 秒）

```powershell
cd <包目录>
powershell -ExecutionPolicy Bypass -File .\install-trpg.ps1 -Repo D:\你的\qq-bridge -Check
```

- 「✓ 跑团插件安装完成」+ 列出 10 处改动 → 放心装
- 「✗ 锚点不存在：xxx」→ 版本不同，**既有文件一个字节都没改**，把报错发出来

> `-Check` 也会把模块文件复制进仓库（这是自检的前提），但不会改 `bridge.js` / `setup-dsh.mjs` / `preset` 等既有文件。

---

## 安装

```powershell
# 基本装法（跑团群稍后在控制台里填）
powershell -ExecutionPolicy Bypass -File .\install-trpg.ps1 -Repo D:\你的\qq-bridge

# 顺便指定跑团群（写进 allow.groups + trpg.allowedGroups）
powershell -ExecutionPolicy Bypass -File .\install-trpg.ps1 -Repo D:\你的\qq-bridge -Group 123456789

# PATH 里没有 node
powershell -ExecutionPolicy Bypass -File .\install-trpg.ps1 -Repo D:\你的\qq-bridge -Node "$env:ProgramFiles\nodejs\node.exe"
```

装完**还差四步**（脚本最后也会打印）：

```powershell
cd D:\你的\qq-bridge
node scripts/build-agent-preset-patches.mjs      # 1. 生成 qq-chat-trpg.patch.yml
node scripts/setup-dsh.mjs                        # 2. 注册 mcp-trpg + 安装 preset
# 3. 重启 DSH（新 MCP / preset 要重启才生效）
# 4. 重启桥接
```

---

## 手动安装（不想跑脚本时）

1. 复制 `src/trpg/` → `<仓库>/src/trpg/`
2. 复制 `scripts/*.mjs` → `<仓库>/scripts/`
3. 复制 `preset-src/qq-chat-trpg/` → `<仓库>/dsh/agent-presets/qq-chat-trpg/`
4. `cd <仓库>` 后跑 `node scripts/install-trpg.mjs`（可先加 `--check`）
5. 再跑上面那四步

`install-trpg.mjs` 会改这些地方（全都幂等，可重复跑）：

| 文件 | 改什么 |
|---|---|
| `src/bridge.js` | 4 处：`TRPG_MODE_FILE` 常量、跑团模式状态与函数、`modePreset` 覆盖、消息入口识别开关 |
| `config.example.json` | 加 `trpg` 段 |
| `scripts/setup-dsh.mjs` | `MANAGED_MCP_IDS` + `mcpEntries` 加 `mcp-trpg` |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs` | `SAFE_PREFIXES` 放行 `mcp__trpg__`（漏了会被 guard 静默拒绝，工具变成「看不见」） |
| `scripts/build-agent-preset-patches.mjs` | `PRESETS` 加 `qq-chat-trpg` |
| `plugins/qq-agent-presets/package.json` | bundle patch 列表加 `./presets/qq-chat-trpg.patch.yml` |

改完自动 `node --check`，不通过会**自动回滚**（备份 `src/bridge.js.bak-before-trpg`）。

---

## 怎么用

### 开团

在跑团群里（**管理员号**）说：

```
打开跑团模式
```

- 桥接把该群的 preset 换成 `qq-chat-trpg` → 会话自动重建（**旧上下文会丢**，这是设计如此）
- 这不是 `/` 命令，群友也看得见；但只有 `ownerQQ` 能开，且只在你指定的群里生效
- 关闭：说「关闭跑团模式」

开之后她会先调 `trpg_state`（这时库里是空的，会回「还没开团」），然后你告诉她：

```
模组叫「常暗」，KP 是我，我演的是娜塔莉娅
```

她会调 `trpg_new` 建团。

### 13 个工具（AI 自己调，你不用管）

| 工具 | 作用 |
|---|---|
| `trpg_new` | 开团 / 合并已有团（并设为当前团） |
| `trpg_state` | ★回现场：场景 + HP/SAN + 线索分布 + 最近事件 + 未解决，≤800 字 |
| `trpg_scene_set` | 切场景 / 游戏内时间 / 未解决疑问 |
| `trpg_clue_add` | 记线索（**source 必填**，默认未验证） |
| `trpg_clue_find` | 按关键词 / 来源 / 场景 / 状态查 |
| `trpg_clue_mark` | 证实 / 推翻 / 存疑（原文不改，只加标记） |
| `trpg_char_new` | 车卡（属性 / 技能 / 物品 / 派生值） |
| `trpg_char_show` | 读角色卡 |
| `trpg_char_patch` | 增量改 HP/MP/SAN/MOV（**reason 必填**） |
| `trpg_timeline_add` | 记事件（只记结论） |
| `trpg_npc_add` | 记 NPC（同名累加笔记） |
| `trpg_npc_get` | 查 NPC |
| `trpg_stats` | 档案规模统计（排查「怎么不记得」时先看它） |

### preset 里的硬规矩（这几条是「不乱套」的关键）

1. **先 RP 再骰点**：零 RP 直接要骰点 = 违规
2. **骰点前问 KP**：「KP，我能掷个侦查吗？」
3. **骰点看得见，但绝不自己解读**：78 对她 65 的侦查算不算失败，等 KP 开口
4. **KP 宣布之前，一个字都不许往下演**
5. 说话格式：`""` 台词、`#` 动作、`（）` 出戏；**`""` 和 `#` 里不许写内心戏**
6. OOC 不许和台词/动作塞进同一条消息

---

## 数据存在哪

```
state/trpg/
├── current.json              当前是哪个团
└── <模组名>/
    ├── campaign.json         模组 / KP / 玩家 / 当前场景
    ├── clues.json            线索卡（id, text, source, verified, confidence, status, marks[]）
    ├── timeline.json         事件（只记结论，不记骰点）
    ├── npcs.json             NPC（态度 / 对他人 / 笔记）
    └── chars/<角色>.json     角色卡 + 改动日志
```

全是人能直接读的 JSON；坏文件会隔离成 `.corrupt-<时间戳>` 再报错，**绝不会被空库覆盖**。

---

## 排错

| 症状 | 查什么 |
|---|---|
| AI 完全不用跑团工具 | `node scripts/probe-trpg-tools.mjs` 跑一遍；看 `plugins/qq-agent-presets/qq-tool-restrict.mjs` 里有没有 `mcp__trpg__` |
| 说「打开跑团模式」没反应 | 桥接日志搜 `[trpg]`；确认是 `ownerQQ` 发的、群在 `trpg.allowedGroups` 里、`trpg.enabled` 不是 false |
| 工具调了但没记下来 | `state/trpg/` 有没有生成目录；`trpg_stats` 看规模 |
| 安装器报「锚点不存在」 | qq-bridge 版本不是 0.2.1-r1，**文件没被改**，把报错发出来 |
| 开团后上下文丢了 | 设计如此：preset 算会话身份，切换就会重建会话 |
| 想整个撤掉 | 恢复 `src/bridge.js.bak-before-trpg`；删 `src/trpg/`、`dsh/agent-presets/qq-chat-trpg/`、`state/trpg/`；撤掉 setup-dsh / restrict / build / package.json 里那几行 |

---

## 和「三层记忆插件」的关系

> 定位：[**三层记忆插件**](https://github.com/Xiao9Feng/qqb-memory-plugin) 是主体，本插件是它的**衍生**——同一套「外置结构化档案、跨重启不失忆」的思路，换到跑团场景里多长出来一本账。主体怎么用随你，跑团只是其中一种玩法。

两套**完全独立**，各存各的：

| | 三层记忆 | 跑团笔记本 |
|---|---|---|
| 记什么 | 群友是什么人（现实人设） | 虚构世界里发生过什么 |
| 目录 | `state/memory/` | `state/trpg/` |
| 谁会写 | 桥接的后台整理任务 | 只有跑团 MCP 工具 |

故意不合并：混在一起会让 AI 把 NPC 当成真群友，或者把群友写进跑团世界。
