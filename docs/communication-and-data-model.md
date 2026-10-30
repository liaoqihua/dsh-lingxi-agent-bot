# 灵犀：通信与数据机制现状（as-is）

> 定位：**只描述现状，不做评价**，作为讨论与完善的基础文档。
> 关联：模块职责与设计取舍见 [mechanisms.md](mechanisms.md)；整理中发现的问题见 [pending-changes.md](pending-changes.md)。
> 代码基准：`dsh-lingxi-agent-bot` v0.4.0，本文所有函数/常量均对应当前实现。

---

## 1. 总体结构

插件只有一条主体模型：**机器人是唯一的连接与个体；聊天（私聊/群聊）各自绑定一个 DSH 会话**。通信分两个互不相交的面：

| 面 | 参与者 | 管道 | 入口文件 |
| --- | --- | --- | --- |
| **数据面** | IM 平台 ↔ DSH 会话 | 通道 → `bridge.deliverInbound` → `agent.followup` → `session/event` → flush → `channel.send` | `lib/session-bridge.js` |
| **管理面** | 设置页 ↔ 插件内部 | HTTP `/api/companion/*`，直接操作 Registry/Bridge/Manager | `lib/api.js` |

```
QQ / 微信 / 飞书
      │ 独立机器人、独立凭据（BotManager 每 bot 一个 Channel 实例）
      ▼
BotRegistry（bots.json）── botId
      ├─ persona.md / memory.json / mood.json / proactive.json
      ▼
聊天（sessions.json 记录）── 1:1 ── DSH 会话（agents.create / resume）
```

核心事实：

- 人格、记忆、心情、主动搭话是**机器人级**状态，同一机器人所有聊天共享；注入时按 sessionId 反查 botId。
- 聊天记录（sessions.json）只承载该聊天的会话绑定、回复目标和时间线，不拥有机器人状态。
- 没有 botId 时记忆/心情/主动搭话的状态路径直接抛错，无全局兜底（`memory.js` / `mood.js` / `proactive-bots.js` 的 `statePath`）。
- 通道实例只在 BotManager 里，出站只能通过 `channelFor(record)` → `getBotChannel(botId)` 拿到本机器人的连接。

---

## 2. 数据模型

### 2.1 存储布局

根目录 `$DSH_HOME/dsh-lingxi-agent-bot/`（`DSH_HOME` 环境变量，缺省 `~/.dsh`）：

```
$DSH_HOME/dsh-lingxi-agent-bot/
├─ config.json              插件级配置（唯一允许手调的默认值与调参）
├─ bots.json                机器人注册表（身份+凭据+新会话默认）
├─ sessions.json            聊天 ↔ DSH 会话绑定（聊天状态唯一真相源）
├─ bots/<botId>/
│  ├─ persona.md            人格全文
│  ├─ memory.json           共享记忆
│  ├─ mood.json             心情状态
│  ├─ proactive.json        主动搭话状态
│  ├─ schedule.json         定时激活记录（提交时间 / 等待间隔 / 任务内容）
│  ├─ weixin.json           微信轮询游标 + 持久去重（仅 webhook 通道使用）
│  └─ chats.json            provision 创建，当前无任何读写（见 pending-changes A1）
├─ voice/                   语音合成临时文件（发送后清理）
├─ inbox/                   预留目录，当前无使用
└─ logs/diag.log            全插件诊断日志（appendLog）
```

所有 JSON 写入走 `writeJsonAtomic`（临时文件+rename）；读取走 `readJsonSafe`（坏文件返回 null）。

### 2.2 机器人记录（bots.json）

`{ version: 1, bots: [记录...] }`，每条记录由 `normalizeBot`（`lib/bots.js`）归一化：

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | string | 新建时默认 `${channel}-${uuid 前 8 位}` |
| `channel` | `qq` \| `webhook` \| `feishu` | 必填 |
| `name` | string | 缺省 = id |
| `enabled` | bool，默认 true | false 时不启动连接 |
| `credentials` | object | 凭据只属于本机器人；字段集按通道不同（见 3.2–3.4） |
| `sessionDefaults` | `{c2c, group}`，每段 `{workspace, preset, provider, model, defaultPermission}` | **新会话默认配置的唯一来源**，按聊天 scope 取值（见 3.6）；`workspace`/`defaultPermission` 必填，`preset`/`provider`/`model` 空 = 宿主默认 |
| `groupEnabled` | bool，默认 false | 群聊入站总开关 |
| `busyMessageMode` | `queue`（默认）\| `steer` | 当前仅 queue 分支被实现 |
| `contextEnhancement` | `{enabled, includeSender, includeChat, guidance≤2000}` | 入站消息的来源块：时间（`now`/`part_of_day`）永远带，其余字段看这个开关 |
| `access` | `{mode: all/allow/block, users≤100, groups≤100}` | 访问名单 |
| `createdAt` / `updatedAt` | number | |

- 顶层 `workspace / preset / provider / model / defaultPermission / sessionId` 已删除；旧格式文件里的这些字段加载时被忽略，不报错、不迁移。
- **重复接入去重**：QQ/飞书按 `credentials.appId`、微信按 `credentials.accountId` 在同通道内查重，命中拒绝入库。
- **删除机器人**：断开连接 → 清空该 bot 的所有聊天绑定（防幽灵占用）→ 删除 `bots/<botId>/` 目录。DSH 会话本身不删。

### 2.3 聊天记录（sessions.json）

`{ version: 1, records: {} }`，key 为 conversationKey，值由 `normalizeRecord` 归一化：

```
key = botId:channel:scope:peerId        （conversationKey，lib/session-bridge.js）
scope = 'c2c' | 'group'
```

| 字段 | 说明 |
| --- | --- |
| `key` / `channel` / `botId` / `scope` / `peerId` | 身份五元组；同一 peer 在不同机器人下是两个聊天 |
| `title` / `renamed` / `senderName` | 展示用；新建时由 `conversationTitle` 生成（含 botName 前缀）；`renamed=true` 后不再被入站自动标题覆盖 |
| `sessionId` | 绑定的 DSH 会话；新建聊天时默认 `derivedSessionId('companion:' + key)` |
| `target` | **通道特定的回复目标**（出站寻址用，见下） |
| `proactive` | `{enabled, lastSpokeAt}`：会话级主动搭话开关（新会话默认私聊开、群聊关）+ 上次开口时间。冷却不在这里——它是机器人级参数（`proactive.json` 的 `cooldownMinutes`），旧数据里的 `record.proactive.cooldownMinutes` 加载时丢弃 |
| `voicePrompt` | `{enabled}`：会话级主动语音开关（新会话默认私聊开、群聊关），只对 QQ 官方 Bot 的聊天有意义；总闸是全插件共用的 `config.voice.promptEnabled`，见 mechanisms.md §7.2 |
| `createdAt` / `updatedAt` / `lastHumanAt` / `lastAssistantAt` / `lastProactiveAt` | 时间线 |
| `messageCount` | 入站计数 |

`target` 按通道的形状：

| 通道 | target | 出站寻址 |
| --- | --- | --- |
| QQ | `{scope, targetId}` | SDK `sendText({scope, targetId})` |
| 微信（原生） | `{conversation}` | `toUserId = record.senderId \|\| record.peerId` |
| 微信（webhook 出站） | `{conversation}` | POST body 的 `conversation` 字段 |
| 飞书 | `{chatId}` | `im/v1/messages` 的 `receive_id` |

不变量：**一个 DSH 会话同时只能绑一个聊天**（`recordForSession` 反查保证，绑定/换绑时校验）。

### 2.4 机器人状态文件

| 文件 | schema 要点 | 通信接触点 |
| --- | --- | --- |
| `persona.md` | 纯文本；**写入限 20000 字**（api.js/tools.js），**注入截断 30000**（`MAX_PERSONA_CHARS`） | context 注入（`required: true`），order 800 |
| `memory.json` | `{version, sessionId, botId, stats{turns,extracted,lastExtractTurn,lastExtractAt}, daily{key,count}, memories[], lastRecall}`；条目：`{id, text≤400, at, importance 0-100, emotion 0-100, factKey≤40, longTerm, source: model/heuristic/tool/import, recallCount, lastRecallAt, supersededAt, supersededBy, deletedAt}` | 回合结束后 `maybeExtract` 写；召回走 context 注入（order 880） |
| `mood.json` | `{botId, mood 0-100, dims{happy,calm,sweet,heartache,worry,sad,jealous}, lastReason≤300, lastConfidence, injectedSessions{sessionId→updatedAt, ≤100 条}, lastInjectedText≤600, lastInjectedAt, timeline≤80, saidAt≤300（当天满额后挤掉最早一条）, minor, kind, updatedAt, lastDecayAt}` | 回合结束后 `maybeJudge` 写；注入走 context（order 890） |
| `proactive.json` | `{version, botId, enabled, intervalMinutes, hitLine, missBonus, bonusCap, quietStart, quietEnd, minIdleMinutes, cooldownMinutes, maxPerDay, prompt, misses, lastSpokeAt, lastTickAt, lastRollAt, lastRoll, saidAt≤300, logs≤80}`；旧数据里的 `target`/`targets` 加载时忽略 | 主动搭话循环读写（见 3.10） |
| `schedule.json` | `{version, botId, jobs[]}`；每条任务：`{id, conversation, sessionId, title, text≤2000, createdAt（提交时间）, waitMinutes（等待间隔）, repeatMinutes（0=一次性）, dueAt, status: pending/done/cancelled/failed, enabled, fireCount, firedAt, attempts, lastError, cancelledAt}`。上限：待激活 20 条 / 总记录 50 条（超了先挤掉最老的已结束记录），连续失败 3 次自动停用，错过 >24h 不再补激活 | 定时 ticker（15 秒）读写；`followup` 走会话桥（见 3.11） |
| `weixin.json` | `{version, getUpdatesBuf, seenMessageIds≤200}` | 仅 WebhookChannel 原生轮询用（见 3.3） |

设计要点：`factKey` 相同 = 同一件会变的事实，新条目自动把旧条目标记 `supersededAt`；`deletedAt` 是软删除（数据保留，不再参与召回）。

### 2.5 配置模型与三层合并

插件级 `config.json`（`lib/config.js` 归一化）：`configVersion / identity / persona / memory / mood / proactive / channels{qq,feishu,webhook} / voice / sessions / tools`。它提供**默认值与调参**，不承载任何机器人身份。

- 这四个模块**没有插件级功能开关**：`persona/memory/mood` 只保留 `order` 与调参（记忆的配额/权重/半衰期、心情的基线/阈值/注入模式、主动搭话的节奏默认值），`enabled` 一律不存在；手写进 config.json 也会被归一化丢掉。模块有没有，由机器人自己有没有这份数据（`bots/<botId>/persona.md` / `memory.json` / `mood.json`）决定。
- 主动搭话的 `prompt` 只作为**新建机器人时的 seed**（写进它自己的 `proactive.json`）；运行时只认机器人自己的文案，不再回落到插件级那句。
- 机器人级总闸在 `bots/<botId>/proactive.json` 的 `enabled`，入口在「会话管理」页。

`BotManager.configFor(bot)` 构造某台机器人运行时配置：

```
1. base      = 插件级 config
2. channelConfig = { ...base.channels[bot.channel], ...bot.credentials,
                     name, enabled, cwd=bot.workspace, preset, provider, model }
3. 凭据清洗：['appId','appSecret','verificationToken','encryptKey','secret',
   'outboundUrl','ownerOpenId','token','aesKey'] 中 bot.credentials 没有的键
   → 从 channelConfig 删除（扫码中的临时通道无 botId，不能借用其他机器人凭据）
4. 结果 = { ...base, channels: { ...base.channels, [kind]: channelConfig } }
```

每个 Channel 实例持有 `getConfig` 闭包，读的是**这台机器人**的合成视图（`this.config = this.getConfig().channels[qq|webhook|feishu]`）。

另外 `updateBot`（`lib/bot-manager.js`）合并 credentials 时过滤空串与掩码值（`/^[•*]+$/`），避免前端回显掩码污染真实凭据。

### 2.6 所有权不变量（现状隐含约定）

1. 聊天 key = `botId:channel:scope:peerId`，全局唯一。
2. 一个 DSH 会话同时只绑一个聊天（换绑/绑定时校验占用）。
3. 一个会话只能属于一个 Workspace（`attachWorkspace` 前后双重校验）。
4. 凭据只来自 `bot.credentials`；跨机器人不借用（configFor 清洗）。
5. 无 botId → 记忆/心情/主动搭话无状态路径，直接抛错，无全局兜底。
6. 出站只走 `channelFor(record)` 拿到的本机器人连接。
7. 子代理会话（`origin==='subagent'` 或有 `parentSession`）不能绑定为聊天。
8. 机器人级状态注入按 sessionId 反查 botId：查不到就不注入（普通 DSH 会话无人格/记忆/心情）。能力清单是唯一例外：普通会话给它一行「这些工具只在机器人聊天里可用，不要调用」（工具注册是全局的，那一行是为了让模型别去试）。

---

## 3. 通信机制

### 3.1 通道抽象与运行时（BotManager）

每个通道实现同一套鸭子接口：`start() / stop() / status() / send({record,text,limit})`，可选 `startQr() / qrStatus() / cancelQr() / sendVoice()`（QQ）。

`BotManager`（`lib/bot-manager.js`）：

- `instances: Map<botId, channel>`；`ensureStarted(bot)` 对 enabled 机器人创建实例并 `start()`，启动失败仅告警不重试（QQ 通道内部自带 15s 重连）。
- `startAll()`：插件启动时遍历所有 enabled 机器人。
- `restart(botId)`：`updateBot` 改 `credentials/workspace/preset/provider/model` 时触发——先 stop 旧实例、删实例、重建。
- `removeBot(botId)`：stop → 清该 bot 全部聊天绑定 → registry 删除状态目录。
- `status()`：聚合每台机器人的 `connected / configured / connecting / lastError / qr`，推导 state（connected/ready/error/connecting/idle）。
- 扫码接入分两条路：QQ 用临时通道（id=`'provision'`、botId 空、onLogin 回调里 `registry.add`）；飞书/微信走 `ChannelProvisioning` 状态机（3.5）。

### 3.2 QQ 官方通道（`lib/channels/qq-official.js`）

- **连接**：`@tencent-connect/qqbot-nodejs` 的 `QQBot`，WebSocket 官方网关（`transport: 'websocket'`，`tokenPrefetch: 'sync'`，`markdownSupport: false`）。就绪超时 20s（`CONNECT_TIMEOUT_MS`）；失败每 15s 重试（timer unref）。凭据 `appId/appSecret`。
- **入站**（SDK `message` 事件 → `#onMessage`）：
  - 只处理 `kind === 'c2c' | 'group'`；`senderIsBot` 丢弃。
  - `peerId`：group 用 `groupOpenid || targetId`，c2c 用 `senderId || targetId`。
  - c2c 的 `senderName` 取 `configFor(bot)` 合成视图里的 `identity.ownerName`——官方 SDK 不给昵称，所以「对方叫什么」只能来自插件设置。取值顺序是 `bot.ownerName`（机器人级）→ `config.identity.ownerName`（插件级兜底），见 3.x 的 `ownerNameFor()`；群聊一律用真实发言人昵称，不参与这次回落。
  - 图片附件：fetch 下载（15s 超时）→ DSH 附件；语音用 SDK 的 `asr_refer_text` 转写为 `[语音转写：…]` 占位。
  - 去重：`bridge.dedupe('qq:' + messageId)`。
- **出站** `send({record, text, limit})`：
  - 正文里的 Markdown 图片 `![](src)` 先抽出（最多 4 张，url 或本地路径），剩余文本 `chunkText` 按 `maxChars`（默认 1500，下限 200）拆段；每段/每图之间 `sleep(120ms)`。
  - 语音 `sendVoice({record, file})`：SDK 原生语音条（REST 上传）。
- **扫码**：`startQrConnect`（`@tencent-connect/qqbot-connector`）；内部状态 `starting → pending → saving → connected`，二维码过期转 `refreshing`，失败/取消为终态。

### 3.3 微信通道（`lib/channels/webhook.js`）

**双入站**并存：

1. **HTTP Webhook**：`POST /api/companion/bots/<botId>/webhook/inbound`（每 bot 独立路由）。可选 `x-companion-secret` 校验。body 字段：`messageId`（去重）、`conversation/senderId/senderName/from`（peerId 兜底链）、`group/scope`、`text/content`、`images[]`（`base64 | url | path` 三种来源，≤8MB/张，≤4 张）、`quote`（≤300）。
2. **原生轮询**（`credentials.token` 存在时启动 `#runWeixinMonitor`）：
   - `notifyWeixinStart` → 循环 `getWeixinUpdates`（iLink 协议，游标 `getUpdatesBuf`）→ `orderWeixinMessages` 排序 → 过滤 `message_type===2` → `weixin.json` 的 `seenMessageIds`（持久）+ `bridge.dedupe`（内存）双层去重 → `deliverInbound`（scope 固定 `c2c`，`target={conversation:sender}`）。
   - 轮询失败退避 `2s × 失败次数`（上限 10s），连续 3 次退出循环。
   - 停止时 `notifyWeixinStop`。

**出站** `send({record, text, limit})`：

- 有 `token` → 原生 `sendWeixinText`（`ilink/bot/sendmessage`，`toUserId = record.senderId || record.peerId`），按 `maxChars` 拆段。
- 无 `token` → POST `outboundUrl`（body `{channel, conversation, scope, senderName, text}`，带 secret header，20s 超时）——由外部桥接服务转发。

凭据集合：`token / accountId / ownerOpenId / baseUrl`（原生）+ `outboundUrl / secret`（桥接）。

### 3.4 飞书通道（`lib/channels/feishu.js`）

- **鉴权**：`tenant_access_token`（`auth/v3/tenant_access_token/internal`），**缓存于内存**，到期前 60s 提前刷新，15s 超时。凭据 `appId/appSecret`，另可配 `verificationToken`（事件校验）与 `encryptKey`（解密+签名）。
- **入站**：事件回调 `POST /api/companion/bots/<botId>/feishu/event`（每 bot 独立路由）：
  - 安全校验：`sha256(timestamp + nonce + encryptKey + rawBody)` 签名比对；`encrypt` 包裹的 body 用 AES-256-CBC 解密（key = sha256(encryptKey)，IV = key 前 16 字节）。
  - `url_verification` 类型回 challenge。
  - `im.message.receive_v1` → `handleEvent`：app/bot 发送者丢弃；`dedupe('feishu:'+messageId)`；群聊默认要求 @ 机器人（`requireMention`）；`post` 类型拼接富文本行；图片经 `im/v1/messages/{id}/resources/{key}` 下载（≤8MB）。
  - `senderName` 显示为 `飞书用户 + open_id 后 6 位`（飞书事件不带可读名字）。
- **出站**：`im/v1/messages?receive_id_type=chat_id`，`msg_type: 'text'`，`receive_id = record.target.chatId || record.peerId`，按 `maxChars` 拆段。

### 3.5 扫码接入状态机（`lib/channel-provisioning.js`）

飞书/微信共用；QQ 走 BotManager 的临时通道方案（3.1）。

```
活跃态：starting / pending / scanned / needs_verification / connecting / saving
终态：  connected / cancelled / expired / error
```

- **每通道同时只有一个 attempt**（`attempts: Map<channel, attempt>`）；重复发起先取消旧的。
- 二维码过期是**惰性判定**：`status()` 查询时检查 `expiresAt`。
- **授权完成前不写 BotRegistry**；`saving` → 验证通过 → `registry.add` + `startBot`。
- **取消是终态**：后续 SDK 回调不能把 `cancelled` 改回活跃态，也不能落库。
- 微信出现 `need_verifycode` → 前端提交 4–8 位配对码 → `verifyWechat(code)`。
- 飞书验证：`registerApp`（node-sdk 设备注册）→ `tenant_access_token` + `/bot/v3/info/` 双重验证通过才入库。

### 3.6 入站管线（`bridge.deliverInbound`，逐序）

所有通道的入站汇入同一条管线（`lib/session-bridge.js`）：

```
1. 空消息拒绝（无文本且无图）
2. 所属机器人校验（getBot(botId) 为空 → "这个消息没有所属机器人"）
3. 群聊总开关（group 且 groupEnabled !== true → 拒绝）
4. 访问名单（mode !== 'all' 时：group 用 access.groups × peerId；
   c2c 用 access.users × (senderId || peerId)；allow=不在拒、block=在拒）
5. touchConversation：key 不存在则登记（title 默认 conversationTitle，
   sessionId 默认 derivedSessionId('companion:'+key)，
   proactive 默认 { enabled: scope === 'c2c', lastSpokeAt: 0 }；
   标题在入站时按对方昵称刷新，除非 record.renamed 已置位）
6. 时间线更新：lastHumanAt = now，messageCount += 1
7. ensureAgent（见 3.7）；失败时返回 { ok: false, error, notify }
   —— 通道拿 notify 往原聊天回一句带原因的提示
8. 来源块 <companion_context>：**必带的 now / part_of_day**
   （模型没有时钟就会自己猜，所以时间不做成开关）；
   上下文增强开着时再追加 channel / scope / sender? / chat? / guidance?
9. 场景行（必带，替代旧的 [senderName] 前缀）：
   群聊 = "（群聊 · 发言人：{senderName}）"，私聊 = "（私聊）"
10. 引用拼"（引用：…）"
11. 图片（≤6 张）保存为 DSH 附件；类型一律按字节嗅探（不吃通道声明的 content_type
    —— QQ 给表情包会声明 image/png 而实际是 webp/gif，宿主会按「声明与字节不符」整张拒绝）；
    嗅探不出就跳过；单张失败降级为文本占位「[收到一张图片，但没能读取]」
12. 组装 user 消息：{ id: `${channel}-${messageId}`（≤120）, role: 'user',
    content, source: { kind: 'companion-im', channel, conversation: key,
    senderName, senderId } }
13. 忙碌判定（busyMessageMode === 'queue' 且 agent.status !== 'idle'）
    → pendingMessages 排队（每会话 ≤20 条，超出丢最旧），返回 {ok, queued}
14. agent.followup(message) → ctx.sessions.flush(session)
```

「会话拉不起来」的提示只覆盖第 7 步（配置/工作区问题）；第 3、4 步的拒绝仍保持静默，避免给拉黑的人回声。

`deliverProactive(record, agent, promptText)` 是同一管线的变体：followup 一条 `source.kind = 'companion-proactive'` 的消息，完成后更新 `record.lastProactiveAt` 与 `record.proactive.lastSpokeAt`。回复由出站桥自然送回原聊天。

正文不是裸文案：`lib/time-context.js` 的 `proactiveBody()` 会在文案前拼一段自带时钟的上下文——

```
<companion_context>
kind: proactive
now: 2026-10-29 周四 17:52:31（Asia/Shanghai，UTC+08:00）
part_of_day: 傍晚
last_human: 2026-10-29 周四 14:52:31（3 小时前，对方最后一条消息）
last_proactive: 2026-10-29 周四 17:42:31（10 分钟前，我上次在这里主动开口）
</companion_context>
（这是我自己此刻想找对方说话的由头，不是对方刚发来的消息。现在是 now 那一刻：…不要自己推算。）

[想开口的由头]
好久没人跟我说话了。
```

理由是这条消息由插件直接塞进会话，**没有宿主准备的回合上下文**，模型拿不到时钟就会把「昨晚」「明天」算错。回合收尾（记忆/心情）用 `proactivePromptOf()` 只取 `[想开口的由头]` 之后那段，避免把注入的背景当成对方说的话。

### 3.7 会话生命周期（`ensureAgent`）

```
get → resume → create，全程 ensuring Map 并发去重（同 sessionId 只跑一次）：
1. live = agentFor(sessionId)（ctx.agents.get，兼容两种 id 写法）
   → #attachActualWorkspace（已有唯一 owner 直接用；无 owner 但有 cwd 则补挂）
   → 失败：抛「这个会话的工作区挂接失败：…」
2. config.sessions.autoCreate 关闭 → undefined
3. agents.resume({resumeSessionId}) → 挂接失败则 dispose 并整体失败
   （get / resume 命中已有会话时不看 sessionDefaults：会话自带 header.cwd）
4. 只有走到这里才要新建，此刻才要求新会话默认配置：
   配置唯一来源 = bot.sessionDefaults[record.scope]（没有兜底链）
   workspace 缺失 → 抛「机器人没有配置{私聊|群聊}会话默认：workspace」
   preset 空 → 落到宿主登记的默认预设（ctx.agentPresets.resolve()），把 id 写进 header
   provider/model 空 → resolveModel(ctx) / listModels 兜底（模型可选语义保留）
5. agents.create({ sessionId, meta: {cwd, agentPreset?}, agentOptions? })
   → #attachWorkspace：attach 前校验"无其他 owner"、attach 后校验"唯一且是自己"
   → 挂接失败：dispose、不发送首轮消息、不回退 process.cwd()
6. 新建后：permissionPresets.set(session, 默认权限)——同时写 preset 行与 sandbox/approval
   开关；宿主没有该服务才回退 session.append('sandbox/mode')；
   sessionTitle.rename(`{titlePrefix}·{botName}-{时间戳}` ≤80 字)
```

失败一律抛出带原因的错（不再返回笼统的「会话拉不起来」），由入站管线转成 `notify`；主动搭话那侧把它记成这一次不开口的原因。

手动绑定（设置页）：`validateBotSession` 前置校验——会话唯一、非子代理、属于该聊天 scope 的 workspace（未归属的会话按 `header.cwd` 反查 workspace 一致才放行）。

### 3.8 出站管线

**事件流**（`installOutbound` 订阅 `session/event`，`#onSessionEvent`）：

```
assistant/message → turnBuffers[sessionId] 追加正文（"\n\n" 连接）
turn/end | turn/error → 删 buffer → #flush + #drainQueue
session/disposed   → 清 buffer
```

**`#flush(sessionId, buffer)`**：

- 无正文有错误：非 abort/cancel 时发固定提示「刚才那一步出错了，我没能说完…」；用户取消则不发。
- 更新 `lastAssistantAt`，`channelFor(record)` 取本机器人通道，`channel.send({record, text, limit})`。
- **兜底 sweep**：15s tick 检查，buffer 超过 120s 未更新则强制 flush（防旧宿主无 turn/end）。
- 出站失败：记日志，**不重试**。

**三条出站路径**（同用 `channel.send`，但生命周期不同）：

| 路径 | 触发 | 特点 |
| --- | --- | --- |
| 主路径：回合 flush | turn/end | 攒 buffer、拆段、更新 lastAssistantAt |
| 工具旁路：`companion_send` | 模型回合内调工具 | `bridge.sendToConversation` 直接发；不开新回合；不更新 lastAssistantAt |
| 语音旁路：`companion_voice` | 模型回合内调工具 | 合成（voice/ 临时文件）→ QQ `sendVoice`；文本仍走主路径，形成「文字+语音条」双发 |

### 3.9 忙碌与排队

- `busyMessageMode = 'queue'`（默认）：会话正忙（`agent.status !== 'idle'`）时入站消息排队（≤20/会话）；`turn/end` 后 `#drainQueue` 取队头一条 followup（逐条消费，非整批）。
- `steer` 枚举存在但无专门分支（等于不排队直接 followup）。
- **主动搭话遇到忙直接撤退**（`attempt` 里 `agent.status !== 'idle'` → "会话正忙，先不打扰"），不排队不插队——与入站的不对称是隐式约定。

### 3.10 主动搭话（`lib/proactive-bots.js`）

```
ctx.interval 30s tick → 遍历所有机器人 → 按 intervalMinutes 判断到点（lastTickAt）→ attempt(bot)
```

`attempt` 门槛顺序（手动触发只跳过冷却/上限/空闲/安静/掷骰，仍尊重会话开关）：

```
1. enabled
2. 今日 maxPerDay（todaySaid 按 saidAt 当天计数）
3. 机器人级 cooldownMinutes
4. 目标选择（状态源唯一化为 record，没有 targets 同步）：
   bridge.listConversations() 过滤 botId + record.proactive.enabled
   → 再按机器人级 cooldownMinutes 剔除「刚开口过的那个会话」（同一个值，没有会话级冷却）
   → 按 lastHumanAt 降序取第一个
5. 对方空闲 ≥ minIdleMinutes（lastHumanAt 距今）
6. 不在安静时段（quietStart~quietEnd，支持跨午夜）
7. ensureAgent 拉得起会话（抛错则记成原因，不开口）
8. agent.status === 'idle'（忙则撤退）
9. 掷骰：roll < hitLine + min(bonusCap, misses × missBonus) 才开口；
   未中 misses+1（下次更容易中），命中清零
10. 文案 = state.prompt（只认这台机器人自己的；插件级 prompt 只在新建时 seed）
    → bridge.deliverProactive（正文带 now / 时段 / 对方多久没说话，见 3.6）
    → followup → 回复由出站桥送回
```

状态写入：命中后 bot 级 `lastSpokeAt / saidAt / misses=0`，会话级 `record.proactive.lastSpokeAt`（由 `deliverProactive` 写）；`logs` 保留最近 80 条尝试记录（含未中的掷骰明细）。显式指定 `targetKey` 时按用户意图直取，不查开关与冷却。

### 3.11 定时激活（`lib/schedule.js`）

```
ctx.interval 15s tick → 遍历所有机器人 → loadStore(botId) → dueJobs(now)
  → activate(botId, job.id)  （一次一条，串行）
```

- `start()` 里除了挂 ticker 还会**立刻补一次 tick**：重启后错过的任务不用等下一个 15 秒。
- 任务存在 `bots/<botId>/schedule.json`（`writeJsonAtomic`），所以重启/热重载后记录还在；重复任务的 `dueAt` 也是落盘的。
- 但 ticker 跑得比 `botManager.startAll()` 早：刚启动时通道可能还不存在。`activate` 因此先查通道就绪——`bridge.channelFor(record)` 必须存在且 `status().configured !== false`；QQ 还要求 `connected === true`（飞书的 `connected` 恒为 false，不能一刀切）。没就绪就按「还没到时候」返回，**不排队、不计失败**，下个 tick 再看；机器人在注册表里被停用同理。等不到才会在 24 小时后落进 `failed`。

`activate` 的判定与后果：

```
1. 只处理 status=pending；自动激活还要 enabled（页面「立即激活」人工越过 enabled）
2. 错过 > 24h（进程没开着、或机器人一直没连上）→ 标 failed，不补激活
3. 按 job.conversation（聊天 key，不是 sessionId）反查 record；
   找不到 → noteFail（连续 3 次 → failed + enabled=false，记录保留）
3.5 通道就绪（见上）→ 没就绪返回 retry，不排队、不计失败
4. bridge.ensureAgent(record)：拉不起会话 → noteFail
5. agent.status !== 'idle' → 直接返回 retry（不排队、不计失败，下个 tick 再来）
6. bridge.deliverActivation → followup({source.kind:'companion-schedule'})
   → 回合结束由出站桥照常送回这个聊天
7. 成功记账：fireCount+1、firedAt=now、attempts=0；
   repeatMinutes>0 → dueAt = now + repeatMinutes，仍 pending；否则 status=done
```

激活正文由 `activationText(job)` 生成：`（定时激活 #id · 提交时间，等了 N 分钟）` + 一句「这是你自己之前给自己定的任务」 + 任务内容。`index.js` 的回合收尾看到 `source.kind === 'companion-schedule'` 就跳过记忆提炼与心情判断。

### 3.12 回合后钩子（`index.js` 的第二个 `session/event` 订阅）

`turn/end | turn/error` 时，与出站 flush **并行**执行：

- 过滤：子代理会话（`parentSession` / `origin==='subagent'`）、`INJECTED_TURN_SOURCES`（runtime-context / time-context / system-reminder / system / time-sampled）、无用户轮、无 `record.botId`。
- `maybeExtract`（记忆提炼）：每日配额 → 轮次/线索词判定 → 模型提炼（失败退启发式）→ 写 `memory.json`。
- `maybeJudge`（心情判断）：宿主模型输出 `{moodDelta, dims, reason, confidence}`；`moodDelta / 3` 落盘；主动搭话的回合用 `mode='talk'`（只判机器人自己说的话）。
- 各自 `void` + catch，互不阻塞出站。

### 3.13 入站去重

| 通道 | 机制 | 持久性 |
| --- | --- | --- |
| QQ | `bridge.dedupe('qq:'+messageId)`，内存 Set 400 条 FIFO | 重启丢 |
| 飞书 | `bridge.dedupe('feishu:'+messageId)`，同上 | 重启丢 |
| 微信 webhook | `bridge.dedupe('webhook:'+messageId)`，同上 | 重启丢 |
| 微信原生轮询 | `weixin.json.seenMessageIds`（200 条，**持久**）+ bridge.dedupe 双层 | 持久 |

微信原生轮询必须持久的原因：游标（`getUpdatesBuf`）回退或丢失时服务端会整段重推，仅内存去重不够；QQ WS 网关与飞书回调是服务端主动推送，重推窗口小。

### 3.14 管理面

- **HTTP API**（`lib/api.js`，`add()` 注册）：`/api/companion/state | sessions | config | persona | memory | mood | proactive | schedule | channels/restart | voice | bots | presets | models | diag`，均按 botId 参数化（persona/memory/mood/proactive/schedule/sessions）或聚合（state/bots）。
  - `POST /api/companion/bots` 的 action：`add` / `update`（两段新会话默认五项校验，缺哪项报哪项）/ `chat.update`（`{botId, key, patch:{title?, proactiveEnabled?}}`；`title` 仍可写，但设置页不再提供改名入口）/ `remove` / `getPersona` / `setPersona` / `bindSession` / `provisionQr` / `provisionStatus` / `provisionVerify` / `cancelProvision` / `test` / `qr` / `cancelQr` / `reconnect`。
  - `bridge.status().conversations[]` 每行带 `proactive {enabled, lastSpokeAt}`，供设置页会话管理页与 `/api/companion/state` 使用。
  - **`/state` 不含宿主会话目录**：宿主没有会话索引（每个会话是 `sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`），列一次要把整个目录解压+解析（实测 61 个会话 ≈ 65MB 压缩 / 350MB 原文，秒级），标题还藏在日志的 `session/title` 投影里。所以宿主会话只服务「会话管理」的换绑候选：`GET /api/companion/sessions?botId=&refresh=` 只返回该机器人两段工作区里的会话 + 已经绑在它聊天上的会话，标题只给这几行读，结果按机器人缓存 15 秒、宿主目录缓存 30 秒；`refresh=1` 才强制重扫。
- **`/schedule`**：`GET ?botId=` 返回 `{jobs, conversations, caps}`——任务的投影（`submittedAt`/`waitMinutes`/`nextText`… 已算好本地时间）与这台机器人可选的聊天；`POST` 的 action：`create`（必须是这台机器人的聊天）/ `cancel` / `remove` / `toggle` / `fire`（人工立即激活）。`/state` 只带 `schedules[].schedule` 摘要（待激活数、总数、下次），完整记录进那一页才拉。
- **`/voice`**：`GET` 不带参数返回 `{voice, qq}` —— 全局合成来源判定（`effective`/`fallback`）、宿主朗读路由可用性（空文本探测）、模型/音色/格式/超时、`apiKeySet`、`voice/` 临时目录残留；带 `?botId=` 时再给 `{bot, targets}`：这台机器人的通道状态（含 AppID / lastError）与本机器人的 QQ 聊天列表（`{key, title, peerId, scope, lastHumanAt, ready}`，`ready` = 有回复目标）。`POST` 合成一句，可选 `sendTo`（可带 `botId` 校验归属）直接发成语音条，发送失败返回 `{ok:false, error}`。设置页对应两页：全局「语音」（合成）+ 机器人级「语音条」（仅 QQ，选中非 QQ 机器人时不出现在导航里）。
- **通道入站路由**在各自 channel 里注册（webhook/feishu 的 per-bot 路由）；**挂饰路由**在 `lib/widget.js`（`widget.js` / 表情图 / status）。
- **`ctx.provide('companion', …)`**：向其他插件暴露 `{channelStatus, bots(), conversations(), mood(botId), schedules(botId), diag}` 只读视图。
- 管理面直接操作 Registry/Bridge/Manager，不经过数据面管道。

---

## 4. 内存态与重启行为

| 内存态 | 位置 | 作用 | 重启后果 |
| --- | --- | --- | --- |
| `handles` | Bridge | sessionId → agent 句柄 | 下条消息 resume 恢复 |
| `ensuring` | Bridge | 进行中的 ensureAgent 任务（并发去重） | 无影响 |
| `turnBuffers` | Bridge | 正在攒的回合正文 | **该轮回复丢失**，IM 侧无回音 |
| `pendingMessages` | Bridge | 排队消息（≤20/会话） | **静默丢失** |
| `seenMessageIds` | Bridge | 入站去重（400 条 FIFO） | QQ/飞书可能重复投递 |
| `instances` | BotManager | botId → channel 连接 | startAll 重建；QQ 通道失败自动重连 |
| `token` | FeishuChannel | tenant_access_token | 重新获取 |
| `recallCache` | memory.js | 召回结果缓存（30s / 60 条） | 冷缓存，仅首次召回慢 |
| `attempts` | ChannelProvisioning | 进行中的扫码任务 | 任务终止（授权未完成不落库，无残留机器人） |

磁盘态（重启保留）：`bots.json / sessions.json / config.json / bots/<botId>/ 全部状态文件`。

---

## 5. 一条消息的端到端旅程

以 QQ 群消息「在吗」为例：

```
QQ 官方网关 WS 推送 message
→ QQOfficialChannel.#onMessage：senderIsBot? 否 → kind=group → dedupe('qq:'+id) 首见
→ peerId = groupOpenid；senderName = 群成员名
→ deliverInbound：机器人存在 → groupEnabled 已开 → 访问名单通过
→ touchConversation 登记/更新 key=botId:qq:group:peerId
→ ensureAgent：agents.get → resume → create（cwd=bot.workspace，
   挂 Workspace，权限走权限预设，预设空则落宿主默认，命名"伴侣·<bot>-<时间>"）
→ 拼正文：[群成员名]\n在吗
→ agent.status==='idle' → followup({role:'user', source:{kind:'companion-im',…}})
→ DSH 回合运行：
   · 注入装配：persona(800) + memory(880) + mood(890) + guide(89980) + capabilities(89985) + voice(89990)，全部是 `required` 的 context，按 sessionId 反查 botId——用户自带预设也拿不掉（见 mechanisms.md §9）。capabilities 只列「有哪些工具、什么时候用、这会儿哪些用不了」，不持有状态
   · 模型回复流 → session/event 'assistant/message' → turnBuffers 攒正文
→ turn/end：
   · Bridge：#flush → channelFor(record) → QQ sendText（chunkText 按 1500 拆段，段间 120ms）
   · index.js 钩子：maybeExtract（记忆）∥ maybeJudge（心情）
→ #drainQueue：若排队中有消息，取队头再 followup
```

任一环节失败的行为：见 [mechanisms.md](mechanisms.md) §11「失败与降级」。
