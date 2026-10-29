# 待修改内容清单（2026-10-27 机制整理）

> 来源：通信与数据机制整理（见 [communication-and-data-model.md](communication-and-data-model.md)）过程中发现。
> 状态：除 B1（已在 [design-scope-sessions.md](design-scope-sessions.md) 中废弃 `bot.sessionId`）外，**均已确认存在于当前代码，暂不处理**，仅记录供后续迭代挑选。
> 每条含：现状（代码依据）→ 影响 → 可选方向（不预设结论）。

---

## A. 文档与实现漂移

### A1. `chats.json` 幽灵文件

- 现状：`lib/bots.js` 的 `provision()` 会为每台机器人创建 `bots/<botId>/chats.json`（`{version:1, chats:{}}`），但全项目没有任何读写它的代码；聊天状态实际全部存于插件级 `sessions.json`（SessionBridge）。README 中「`bots/<botId>/`：人格、记忆、心情、主动搭话和聊天相关状态」的表述会误导读者。
- 影响：误导人；空文件累积。
- 方向：① 从 provision 模板移除 + README 更正；② 或真正把 per-chat 状态迁入该文件（与 sessions.json 职责重新划分）。

### A2. 人格字数上限三层不一致

- 现状：写入路径 `lib/api.js`（两处）与 `lib/tools.js` 的 `persona_set` 限制 **20000** 字；注入路径 `lib/persona.js` 的 `MAX_PERSONA_CHARS = 30000`（超长截断）；文档已不再记录该数值，以代码为准。
- 影响：写入 20001~30000 字的人格文件只能由手工放置文件产生；注入截断阈值实际几乎不触发。
- 方向：统一为一个数（20000 或 30000），各写入路径与注入路径同步。

### A3. `busyMessageMode = 'steer'` 悬空

- 现状：`lib/bots.js` 的 `normalizeBot` 接受 `'steer' | 'queue'` 两值；但 `lib/session-bridge.js` 的 `deliverInbound` 只实现 queue 分支，`steer` 落到「直接 followup」，语义上等于不排队。README 与 mechanisms.md 均未提及 steer。
- 影响：前端可选一个没有实际语义的值。
- 方向：① 删除 steer 枚举；② 或实现真正的 steer（打断当前回合插入消息，取决于宿主 followup 能力）；③ 至少先在文档标注「预留、当前等于不排队」。

## B. 行为疑点

### B1. `bot.sessionId` 的「首个未绑定聊天的默认」语义 —— **已处理（2026-10-27）**

- 原现状：`deliverInbound` 每条消息都把 `bot.sessionId` 当候选：若已被其他聊天占用则**当场清空重派**（该聊天改用派生 id 新建会话），但机器人记录上的字段**从不回写清除**。占用解除后该字段会「复活」，新的第一个聊天又可能绑到它。
- 处理：按 [design-scope-sessions.md](design-scope-sessions.md) 直接**废弃 `bot.sessionId`**——候选逻辑整段移除，聊天会话只由 `record.sessionId` 与 `bindSession` 决定。旧字段加载时忽略。

### B2. `companion_send` 旁路不更新会话时间线

- 现状：`lib/session-bridge.js` 的 `sendToConversation`（工具旁路出站）直接调 `channel.send`，不更新 `record.lastAssistantAt`（主路径 flush 会更新）。
- 影响：仅影响状态页「最后回复时间」的准确性；不影响主动搭话判定（其用 `lastHumanAt`）。
- 方向：补一行更新即可，或接受为展示误差。

## C. 可靠性与竞态

### C1. 数据面可靠性边界 = 单进程内存态

- 现状：`turnBuffers`（正在攒的回合正文）、`pendingMessages`（排队消息）、`seenMessageIds`（QQ/飞书入站去重）全部只在内存；进程崩溃/重启后，正在跑的回合的回复**整体丢失**（IM 侧无回音），排队消息**静默丢失**，QQ/飞书消息可能重复投递。出站失败一律只记日志不重试。微信因轮询模型特殊（`weixin.json` 持久游标+去重）是唯一例外。
- 影响：陪伴场景大概率可接受，但「用户发了消息、机器人永远没回」无任何用户可见痕迹。
- 方向：① 接受并在文档写死边界（本清单即此）；② 排队消息与去重持久化到 `bots/<botId>/`；③ 出站加有限重试。三者独立，可分别取舍。

### C2. `maybeJudge` 读-改-写竞态

- 现状：`lib/mood.js` 的心情判断是 load → judge → save 的异步读改写，同一机器人的多个聊天同时结束回合时后写覆盖先写（memory 模块有 `inflight` 去重，mood 没有）。
- 影响：偶发丢失一次心情变化，无数据损坏（写入原子）。
- 方向：加 inflight 合并或写前 re-read diff；或接受为已知取舍。

### C3. `recordForSession` 线性扫描

- 现状：`lib/session-bridge.js` 的 `recordForSession` 每次全表遍历 `db.records` 并对每条做 `sessionIdCandidates` 双写法匹配；它位于 `session/event` 热路径上——包括每条 `assistant/message` 事件。
- 影响：几十个聊天的规模下无感；上规模后是每事件 O(n)。
- 方向：维护一个 `sessionId → key` 的内存索引（load/save 时重建）；或记录为已知取舍。

### C4. 入站去重三通道不同构

- 现状：QQ/飞书仅内存 `seenMessageIds`（400 条 FIFO，重启丢）；微信原生轮询额外持久 `weixin.json`（200 条 + 轮询游标）。
- 影响与理由（并存）：QQ 官方 WS 网关与飞书事件回调是服务端主动推、重推窗口小；微信是轮询拉取、游标丢失会整段重拉，**不同构部分源于传输模型差异，未必是缺陷**。
- 方向：① 文档记录传输模型与去重策略的对应关系（本文档 3.13 已写）；② 若要统一，按通道能力分级持久化。

### C5. `updateBot` 重启窗口期发送

- 现状：`lib/bot-manager.js` 的 `updateBot` 改凭据/工作区等字段会 `restart(botId)`：先 stop 旧实例再建新实例；进行中的 `channel.send` 可能打到已 stop 的旧实例上。
- 影响：低频操作窗口内偶发一次发送失败（返回 `ok:false` 记日志）。
- 方向：接受（操作本身低频且用户可见）；或 restart 前等在途发送完成。

## D. 宿主交互（2026-10-27 排障记录）

### D1. 会话恢复必须带 provider/model —— **已修（2026-10-27，0.4.2）**

- 现状（错）：`ensureAgent` 的恢复分支只传 `resumeSessionId`，`agentOptions` 是恢复失败后才为「新建」算的。而宿主把 `{{model}}` 提示词变量取自 `agent.options.model`（`ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)`），**provider 可以返回 undefined，但一旦有段落引用它，渲染就抛错**。
- 症状：DSH 重启后，恢复出来的会话在**首个回合**直接失败——`prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`，出站只能发兜底文案。主动搭话与入站消息同样中招。
- 处理：provider/model 解析提前到恢复之前，`agents.resume({ resumeSessionId, agentOptions })` 一并传入（与新建路径同源）。测试 90 项通过。
- 遗留：宿主行为是**故意严格**的（"a malformed prompt is worse than a loud failure"），所以任何「无 model 的 agent」都会踩同一坑；profile 侧可把 `system-prompt.personaPrefix` 的 `{{model}}` 去掉作为额外加固。

### D2. 任意 Agent Preset 都拿不掉灵犀的注入 —— **已加固（2026-10-27，0.4.2）**

- 原现状（错）：灵犀的四块注入里，`companion:guide` 是 **section**，人设/记忆/心情虽是 context 却**没标 `required`**。于是用户的预设可以合法地拿走我们的东西：`@deepseek-ai/dsh-persona` 的 `includeRuntimeContext: false` → `suppressRuntimeContext()` **只抑制可选上下文** → 人设/记忆/心情一起静默消失；`complete: true` → 所有 section（含守则）被顶掉。
- 处理：
  1. 四块注入全部改为 `context` 且 `required: true`——抑制器动不了，`refreshContext` 还会把缺失的 required 补齐；
  2. 新增 `lib/injection-health.js`：每个注入函数被求值时记一笔，回合结束对账，缺项写诊断日志并出现在 `/api/companion/state` 的 `injectionWarnings`；
  3. 测试 `tests/preset-resilience.test.mjs` 覆盖注册形状、被抑制时可对账、失败回合不误报。
- 遗留（属于预设自己的选择，不是灵犀的缺陷）：`complete: true` 依然会顶掉 **DSH 自己的**身份行与工具指导，只是灵犀的上下文不受影响；工具可见集合在预设自带工具清单时是否受限，尚未实测。
- 附注：`sessionDefaults.c2c.preset = whale-girl`，`sessionDefaults.group.preset` 为空——群聊会话走部署级 persona（带 `{{model}}` 的那份），D1 的修复对群聊尤其关键。

### D3. 新建会话的「预设」与「权限」没按宿主契约写 —— **已修（2026-10-27，0.4.3）**

- 症状（微信机器人实测）：新建会话**没有预设**、权限显示 **`custom`**；而 QQ 机器人新建的会话一切正常。
- 根因两条，互不相干：
  1. **预设**：旧实现只在机器人配了 `sessionDefaults[scope].preset` 时才传 `meta.agentPreset`；没配就什么都不传 → 会话没有 preset 行，界面显示「无预设」，行为也偏离宿主默认（宿主的 `agent-presets` registry 里有 `default`，插件建的会话却没用上）。
  2. **权限**：旧实现只 `session.append('sandbox/mode', …)`：`permission/preset` 行仍是宿主默认值，与新的 sandbox 组合对不上任何命名预设 → `permissionPresets.current()` 返回 `CUSTOM_PRESET`，界面显示 `custom`。
- 为什么 QQ 那边「看起来正常」：QQ 机器人显式配了 `preset = whale-girl`（第 1 条不触发），且 `defaultPermission = workspace-write` **恰好等于宿主默认**（第 2 条的错位被数值一致掩盖）。一旦把权限改成 `danger-full-access` 就立刻暴露——这也是这个 bug 一直没被发现的原因。
- 处理：
  1. 预设空 → `ctx.agentPresets.resolve()` 取宿主默认预设的 id 传给 `meta.agentPreset`（拿不到才按无预设走）；
  2. 权限 → `ctx.permissionPresets.set(session, name)`，由宿主同时写 `permission/preset` 行与 sandbox/approval 开关；服务缺失才回退裸写 `sandbox/mode`；
  3. 创建日志补上「权限=…」便于排查；
  4. 测试 `tests/create-defaults.test.mjs`（默认预设回落 / 显式预设优先 / 走权限预设 / 无服务回退）。
- 附带修正：`companion:guide` 现在只在机器人会话注入（此前普通 DSH 会话也会收到陪伴守则，而它们并没有记忆/心情）。
