# 设计：会话模块与私聊/群聊区分

> 状态：**已实现**（2026-10-27；实现记录见文末第 8 节）。
> 前提：插件尚未正式发布使用，**不做任何数据兼容与迁移**，旧格式字段加载时直接忽略，按新 schema 解释。
> 现状文档：[communication-and-data-model.md](communication-and-data-model.md)；已知问题：[pending-changes.md](pending-changes.md)。

---

## 0. 需求（外特性口径）

1. 设置中新增**「会话」模块**：管理机器人下的所有聊天会话，能看到每个会话是私聊还是群聊、名字和 id，并能设置该会话是否开启主动搭话。
2. **新会话默认配置按私聊/群聊分叉**（完整五项），缺省不回落，该报错报错、该提示提示。
3. 人格、记忆、心情**保持机器人级共享**（明确的设计决策，不按 scope 隔离）。
4. 主动搭话**区分在哪个会话中开口**——由会话级开关实现。

## 1. 决策记录

| 决策点 | 结论 |
| --- | --- |
| 旧数据 | 不迁移不兼容：bots.json 顶层五字段、proactive.json targets、bot.sessionId 加载时全部忽略；会话主动搭话开关重置为 scope 默认（私聊开 / 群聊关） |
| 配置缺失表现 | 设置页保存时校验提示；运行时 ensureAgent 失败 → 入站管线返回结构化错误 → **通道回一句明确提示到 IM**（不再静默日志） |
| scope 信号 | 私聊与群聊**都显式**标记，必带，不依赖 contextEnhancement |
| `bot.sessionId` | 废弃（「首个未绑定聊天的默认」语义随之消失，pending-changes B1 关闭） |
| cwd 兜底链 | 删除（workingDirectory 服务 / 第一个 workspace / process.cwd() 兜底全部移除）；`sessionDefaults[scope].workspace` 是唯一来源 |
| 记忆/心情隔离 | 不做（保持 bot 级单池；跨聊天共享是特性） |
| per-scope 策略段 | 不做（per-chat 开关已覆盖「群聊更克制」的诉求；bot 级节奏参数保持单一） |

## 2. 数据模型

### 2.1 bots.json

删除顶层 `workspace / preset / provider / model / defaultPermission / sessionId`。新增：

```json
{
  "id": "qq-a1b2c3d4",
  "channel": "qq",
  "name": "灵犀",
  "sessionDefaults": {
    "c2c":   { "workspace": "…", "preset": "", "provider": "", "model": "", "defaultPermission": "workspace-write" },
    "group": { "workspace": "…", "preset": "", "provider": "", "model": "", "defaultPermission": "read-only" }
  }
}
```

- `normalizeBot`：读取 `sessionDefaults.{c2c,group}` 各五项（字符串，权限枚举校验）；旧顶层字段**忽略不报错**。
- 完整性校验由两层承担：设置页保存时（api.js 校验两段五项非空权限合法，缺哪项提示哪项）；运行时（ensureAgent 缺字段抛带具体字段名的错误）。
- `provider/model` 空串仍允许（意为「用宿主默认」），`workspace/defaultPermission` 必填。

### 2.2 sessions.json（聊天记录升格为会话模块数据源）

record 新增字段：

```json
{
  "key": "qq-a1b2c3d4:qq:group:ABC123",
  "scope": "group",
  "title": "老友群",
  "channel": "qq",
  "peerId": "ABC123",
  "sessionId": "companion:xxx",
  "proactive": {
    "enabled": true,
    "cooldownMinutes": 30,
    "lastSpokeAt": 0
  }
}
```

- `proactive.enabled`：每会话主动搭话开关；**新聊天登记（touchConversation）时默认 `scope === 'c2c'`**。
- `title`：支持手动重命名（会话模块入口）。QQ 群/私聊名 SDK 拿不到，重命名是主路径；飞书可选做自动补名（群聊首次入站调 `im/v1/chats/{chatId}`），列为低优先级后续项。

### 2.3 proactive.json（职责收缩为 bot 级参数与统计）

删除 `targets[]`、`target`。保留：

```json
{
  "version": 1,
  "botId": "…",
  "enabled": true,
  "intervalMinutes": 30,
  "hitLine": 30,
  "missBonus": 10,
  "bonusCap": 40,
  "quietStart": 23,
  "quietEnd": 7,
  "minIdleMinutes": 60,
  "cooldownMinutes": 20,
  "maxPerDay": 6,
  "prompt": "……",
  "misses": 0,
  "lastSpokeAt": 0,
  "lastTickAt": 0,
  "lastRollAt": 0,
  "lastRoll": null,
  "saidAt": [],
  "logs": []
}
```

`cooldownMinutes` 语义变化：从「per-target 默认值」变为「会话级冷却的缺省值」——`record.proactive.cooldownMinutes` 未设置（0）时用它。

## 3. 行为变更

### 3.1 入站管线（deliverInbound）

**场景行（两边显式，必带）**，替代现有 `[senderName]` 前缀：

```
群聊正文 = （群聊 · 发言人：{senderName}）\n{正文}
私聊正文 = （私聊）\n{正文}
```

- 不依赖 `contextEnhancement.enabled`；contextEnhancement 保留，仅在其开启时附加 `<companion_context>`。
- guide section 同步更新：说明两种标记的含义与群聊注意（多人在场、说话注意分寸）。

**失败回提示**：`ensureAgent` 失败时不再返回笼统的「会话拉不起来」，而是带原因（如「机器人未配置群聊会话默认：workspace」）；`deliverInbound` 返回 `{ok:false, notify:'…'}`；**各通道入站 handler 收到 notify 后调用 `channel.send` 回给原聊天一句提示**（三个通道各加一处，QQ 群聊需 target 可用才回）。

### 3.2 ensureAgent（无兜底）

```
配置唯一来源 = bot.sessionDefaults[record.scope]
  workspace     缺失 → 抛「机器人未配置{私聊|群聊}会话默认：workspace」
  preset        空串 → 落到宿主登记的默认预设并传它的 id（agentPresets.resolve()）
  provider/model 空串 → resolveModel(ctx) / listModels 兜底（模型可选语义保留）
  defaultPermission → permissionPresets.set(session, name)（同时写 preset 行与开关；
                     宿主没有该服务才回退 session.append('sandbox/mode')）
删除：#cwd 的 workingDirectory 服务 / 第一个 workspace / process.cwd() 三级兜底
删除：bot.sessionId 候选逻辑（deliverInbound 第 5 步整段移除）
注：这个门槛只在真要「新建」时生效——get / resume 命中已有会话时不看 sessionDefaults
    （会话自带 header.cwd），避免「新会话默认没填」连带掐断已经绑好的聊天。
```

### 3.3 主动搭话判定链（proactive-bots.js）

```
tick（ctx.interval 30s）
→ 遍历机器人 → 到点（intervalMinutes × lastTickAt）
→ attempt(bot)：
  1. bot 级 enabled
  2. 今日 bot 级 maxPerDay（saidAt 总数计数）
  3. bot 级 cooldownMinutes（lastSpokeAt）
  4. 目标选择：bridge.listConversations() 过滤 botId + record.proactive.enabled
     → 按 lastHumanAt 降序取第一个
  5. 会话级冷却：record.proactive.cooldownMinutes（0 = 用 bot 级缺省）× record.proactive.lastSpokeAt
  6. 对方空闲 minIdleMinutes（bot 级）
  7. 安静时段（bot 级）
  8. ensureAgent + agent.status === 'idle'（忙则撤退，不插队）
  9. 掷骰（bot 级 hitLine + misses 补偿）
  10. prompt（bot 级单一文案）
  → deliverProactive
  → 成功更新：bot 级 lastSpokeAt / saidAt / misses=0 + record.proactive.lastSpokeAt
```

删除：`syncTargets` / `pickTarget` 的 targets 同步机制（状态源唯一化为 record）。

### 3.4 状态 API

`bridge.status().conversations[]` 每行补 `proactive`（enabled/cooldownMinutes/lastSpokeAt），供设置页会话模块与 `/api/companion/state` 使用。

## 4. 设置页（client.js）

原始排布把「会话」放在机器人详情里；**后续按用户要求调整为**：会话管理升为最外层导航的一个页面，导航按「全局设置 → 当前机器人」重新分组（日志也归入全局设置）。现行结构：

```
全局设置
  ├─ 机器人                     连接与凭据 · 机器人个体 · 新会话默认配置（私聊 | 群聊各五项）
  ├─ 语音                       全插件共用的合成来源（仅 QQ 有「语音条」子页，见下）
  └─ 日志                       插件自己的运行记录
当前机器人  [选择器]            选择器 + 这台机器人的页面在同一组
  ├─ 总览
  ├─ 人格 / 共享记忆 / 心情
  ├─ 主动搭话 ★只放机器人自己的东西：节奏参数（频率/命中线/上限/安静时段/冷却/文案）
  │                          + 搭话统计 + 这台机器人的尝试日志（不放开关、不放会话状态）
  ├─ 会话管理 ★                 总闸：[这台机器人会自己开口]
  │                          私聊组 / 群聊组，每行：title · peerId · 会话（短）· 通道 · 最近活跃 · 消息数
  │                          [会话级主动搭话开关] [换绑会话]
  └─ 语音条（仅 QQ）           这台机器人的 QQ 通道状态与可发送的聊天
```

- 「机器人」「语音」「日志」都是全局的（不属于任何一台机器人），排在当前机器人组之前。
- **开关归属**：主动搭话的机器人级总闸和每个会话的闸门都放在「会话管理」；「主动搭话」页只负责参数（含冷却）、统计、日志。
- **改名不在这里**：会话名由 `conversationTitle()` 按通道 + 对方昵称生成、入站时跟随昵称更新；页面上没有改名入口（原按钮用 `window.prompt`，在 Electron 里不实现，点了没反应，且只改插件自己的标签、不改 DSH 会话标题）。API 的 `chat.update` 仍接受 `title`，供脚本/其它客户端使用。
- 换绑会话沿用现有 `validateBotSession` 逻辑（会话唯一、非子代理、该 scope 的 workspace 一致性校验）。

## 5. API 变更

| 接口 | 变更 |
| --- | --- |
| `POST /api/companion/bots` | 新增 action `chat.update`：参数 `{botId, key, patch: {title?, proactiveEnabled?, proactiveCooldownMinutes?}}`；写 record 并 save |
| `GET /api/companion/state` | conversations 补 `proactive` 字段 |
| `POST /api/companion/bots`（update） | 校验 `sessionDefaults` 两段五项完整，返回具体缺失项 |
| 删除 | bot 级 sessionId 相关的设置读写（字段已废弃） |

## 6. 实现清单（文件级）

| 文件 | 改动 |
| --- | --- |
| `lib/bots.js` | normalizeBot：sessionDefaults 两段五项；忽略旧顶层字段；删 sessionId |
| `lib/session-bridge.js` | record normalize 加 proactive；deliverInbound：场景行、删 bot.sessionId 候选、失败返回 notify；ensureAgent：sessionDefaults[scope] 无兜底、删 #cwd 兜底链；status() 补 proactive |
| `lib/proactive-bots.js` | normalizeState 删 targets/target；attempt 判定链改 record；删 syncTargets/pickTarget |
| `lib/channels/qq-official.js` `webhook.js` `feishu.js` | 入站 handler：deliverInbound 返回 notify 时回提示消息 |
| `index.js` | guide section 更新（两种标记说明） |
| `lib/api.js` | chat.update action；sessionDefaults 校验；conversations 补字段 |
| `client.js` | 「会话」模块 UI；新会话默认两块；主动搭话区块调整 |
| `tests/*` | 对应更新（bots/session-bridge/proactive-bots/channels 的用例重写相关部分） |

## 7. 明确不做（本轮范围外）

- 人格 / 记忆 / 心情按 scope 隔离（保持 bot 级共享）。
- 主动搭话 per-scope 策略段（scopes.c2c/group）。
- 出站重试、排队持久化、去重统一（pending-changes C 组维持现状）。
- 飞书群名自动获取（低优先级后续项）。

## 8. 实现记录（与设计的差异 / 补充决定）

实现按第 6 节清单逐文件完成，测试从 63 项扩到 78 项、0 失败。以下几处是设计没有写到、实现时定下的细节：

| 位置 | 补充决定 | 理由 |
| --- | --- | --- |
| `record.renamed` | session 记录多一个布尔字段：手动重命名后置 true，入站自动标题不再覆盖 | 设计的 record 形状里没有它，但「重命名是主路径」必须不被下一条入站消息冲掉 |
| `missingSessionDefaults` | `defaultPermission` 缺失或非法也算「缺项」一并报出（不只 workspace） | 对应「校验两段五项非空权限合法，缺哪项提示哪项」 |
| 群聊默认权限 | 新机器人的两段默认权限都是 `workspace-write`（不把群聊预设成 `read-only`） | 设计只声明了「主动搭话开关按 scope 默认分叉」；权限分叉留给用户在设置页显式选择，示例里的群聊 read-only 只是示例配置 |
| 手动「现在说一句」 | 仍尊重会话级开关（只跳过冷却 / 上限 / 空闲 / 安静时段 / 掷骰）；显式指定会话 key 时按用户意图直取 | 需求 4 把「在哪个会话开口」交给会话开关；手动按钮不该绕过用户刚关掉的会话 |
| 目标选择与冷却的先后 | 先剔除还在会话级冷却里的会话，再按 `lastHumanAt` 降序取第一个；如果开着开关的会话全在冷却里，这一次就不开口 | 与旧 `pickTarget` 的 `eligible`（enabled + 冷却）过滤顺序一致；§3.3 把「选择」与「冷却」写成两步只是叙述，不改变先过滤后排序的语义 |
| 会话管理的落点 | 独立成最外层导航页 `ChatsPanel`（不再嵌在机器人详情里），导航重排为「全局设置（机器人、日志）/ 当前机器人（选择器 + 总览、人格、记忆、心情、主动搭话、会话管理）」 | 用户要求；机器人的「新会话默认」与「已有会话」分属两页后，总览与主动搭话页都加了跳转到会话管理的入口 |
| 会话管理里的「未保存工作区」提醒 | 拆页后没有表单态可判脏，改为按已保存的 `sessionDefaults[scope].workspace` 渲染；缺工作区时提示去「机器人 → 新会话默认配置」并禁用换绑 | 换绑候选会话本来就依赖已保存的工作区 |
| 宿主会话目录的取数 | 从 `/api/companion/state` 摘出来，改由 `GET /api/companion/sessions?botId=&refresh=` 按需给（只给这台机器人两段工作区里的会话 + 已绑在它聊天上的会话，标题只给这几行读）；宿主目录缓存 30 秒、候选缓存 15 秒、标题按 (id, updatedAt) 缓存，`refresh=1` 强制重扫 | 宿主会话没有索引：列一次要把 `sessions/` 整个解压+解析（61 个会话 ≈ 65MB 压缩 / 350MB 原文），原来每次打开设置页、每次切页都扫一遍，实测单次 2.7–7 秒；现在打开设置页完全不碰宿主会话，只有「会话管理」付一次代价 |
| 候选去重 | `/sessions` 每行带 `boundKey`（已被哪个聊天绑走），界面上按它排除「已被别的聊天占用」的会话 | 原来客户端只知道自己机器人的绑定集，看不到别的机器人占用的会话 |
| 语音状态页 | 全局设置区新增「语音」页（`VoicePanel`，原 `VoiceCard` 是没被渲染的死代码）放合成：来源判定、宿主朗读路由可用性、`voice/` 临时目录残留，以及只合成试听 | 用户要求把语音相关状态展示出来 |
| 语音的全局 / 机器人级拆分 | 再拆出机器人级「语音条」页（`VoiceSendPanel`）：**只在选中 QQ 官方 Bot 机器人时出现**（webhook / 飞书的通道没有 `sendVoice`），放这台机器人的 QQ 连接状态、合成是否可用、可发语音的聊天 N / 总数、按聊天发送；`GET /api/companion/voice?botId=` 才返回 `{bot, targets}` | 合成是 `config.json` 里的全局一份，发送能力只有 QQ 有；用户要求按这个分界拆两页并做条件显示 |
| workspace 门槛只管新建 | `ensureAgent` 里 workspace 校验与 provider/model 兜底查询从「进函数就做」挪到「resume 失败、真要 create」那一步；get / resume 命中已有会话时不看 `sessionDefaults` | 实测发现线上机器人的两段 workspace 都是空的（旧顶层字段被忽略后没人填），而「新会话默认配置」不该管已有会话——否则 DSH 一重启，已绑好的聊天会因为缺一个跟它无关的默认值而收不到回复 |
| 主动搭话开关的归属 | 去掉「主动搭话」页里的「启用主动搭话」总闸和「会开口的会话」卡片；总闸搬到「会话管理」顶部，和每会话开关同一页。主动搭话页只留：节奏参数 + 搭话统计 + 这台机器人的尝试日志 | 用户要求：这一页属于这台机器人的“搭话参数/统计/日志”，开关与会话状态归会话管理 |
| 主动搭话表单不被统计刷新冲掉 | 表单同步改用「已保存参数的签名」做依赖（而不是整个 `state`/`proactive` 对象），统计字段变化不再重置未保存的编辑；表单首帧直接由数据构建，不再闪「读取中」 | 原来点「现在说一句」（会 refresh）或切页刷新都会把没保存的参数改动冲掉 |
| 插件级不再有模块总开关 | 删掉 `config.persona/memory/mood.enabled`（含 `normalize` 输出）与对应的运行时判断；旧 config.json 里手写这三个字段会被归一化丢弃 | 人格/记忆/心情都是机器人级模块，插件级只该给默认值与调参；留着这三个静默闸门等于旧版「全局模块」残骸，一旦被关掉，所有机器人会无声失去人格/记忆/心情 |
| 主动搭话文案只有机器人一份 | 去掉运行时 `state.prompt \|\| config.proactive.prompt` 回落；`config.proactive.prompt` 只作为新建时的 seed，设置页在机器人文案为空时把这段默认填进输入框供直接编辑 | 否则多台机器人共用一句隐藏文案，而设置页那格是空的，看不到实际会发什么 |
| 注入健康可见 | `injectionWarnings` 接到「总览」顶部提示（只列当前机器人的会话，带缺失的注入名） | 预设抑制运行上下文时原本只有日志能发现，机器人会静默少掉人格/记忆/心情 |
| 冷却只有机器人级 | 删掉会话级冷却（`record.proactive.cooldownMinutes` + 会话行的输入框 + `chat.update` 的 `proactiveCooldownMinutes`）；`coolingDown()` 只吃机器人级 `cooldownMinutes`，同一个值既限「这台机器人多久再开口」也用来剔除「刚开口过的那个会话」 | 同名为「冷却」的东西出现在两页会让人不知道该调哪个；冷却属于「主动搭话」页的节奏参数 |
| 去掉会话改名入口 | 删掉会话行上的「重命名」（原实现用 `window.prompt`，Electron 不实现该 API，点了静默无反应；且它只改插件自己的标签、不改 DSH 会话标题）；标题改回自动（`conversationTitle()` + 入站按对方昵称刷新）。API 的 `chat.update` 仍接受 `title` | 用户反馈「没啥用」；保留一个点了没反应、又容易误解的按钮不如去掉 |
| `record.proactive.lastSpokeAt` | 由 `deliverProactive` 在成功 followup 后写入（含 `lastProactiveAt`） | 状态源唯一化：开口成功的那一刻只有它有真实语义 |
| `bots.js` 派发新会话的落点 | 扫码接入（飞书 / 微信 / QQ）创建的机器人 `sessionDefaults` 留空，读取 `config.channels.<channel>.sessionDefaults` 作为起点（默认没有这个键） | 接入时还不知道用户要哪个工作区；缺工作区会按设计明确报错，而不是回落到 cwd |
| `lib/channels/webhook.js` | 桥接模式出站改用 `this.fetchImpl`（原本直接调全局 `fetch`） | 让「notify 回提示」这条新路径可测，与通道已有的注入风格一致 |
| `tools.js` / `persona` / `memory` / `mood` | 保持 bot 级共享与既有工具语义；后续收尾：删掉三者的插件级 `enabled` 静默闸门（模块有无由机器人有没有这份数据决定） | 设计明确不做 case:scope 隔离；插件级不应再有模块总开关 |

未处理的既有问题（本轮范围外，仍在 [pending-changes.md](pending-changes.md)）：`chats.json` 幽灵文件（A1）、人格字数上限不一致（A2）、`steer` 枚举悬空（A3）、C 组可靠性边界。
