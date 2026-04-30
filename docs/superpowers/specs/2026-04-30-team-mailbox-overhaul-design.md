# P1 — 邮箱底座升级（参考 Claude Code 同款）

**日期**：2026-04-30
**所属重构**：Team 模式整体对齐 Claude Code 的 P1 阶段
**目标项目**：`code-agent/`（参考实现：`claude-code/`，仅读不改）

---

## 1. 背景

当前 `code-agent` 的 team 实现使用 `.team/inbox/{name}.jsonl` + drain（读后清空）模式，且 lead 收到的队友消息只在用户主动提交 prompt 时才被半自动注入（`index.tsx:1833`）。这与 Claude Code 的"持续运行时 + 自动消息投递"体验差距明显。

P1 阶段只解决邮箱底座层面的问题：**消息存储格式、读语义、注入触发时机**。多团队、协议消息、AsyncLocalStorage 等更上层改动放在 P2 / P3 / P4 处理。

## 2. 范围

### 2.1 包含
- 邮箱文件格式从 `JSONL append-only` 换成 `JSON 数组 + read 标记`
- 引入 `proper-lockfile` 做并发写入串行化
- 新增 `readUnread / markRead / unreadCount` API，删除 `drainInbox`
- 注入文本格式换成 CC 同款 `<teammate-message>` XML tag
- Lead 主 loop 改造为「严格 CC 同款自动连续回合」：当前轮结束后只要有未读自动开下一轮，无未读才停
- Teammate loop 同步换成 readUnread + markRead 模式
- 删除 `lead_inbox` 工具、`renderInboxPrompt`、`formatMailboxMessages` 等过时 API
- `MailboxMessage` 字段简化为 CC 同款，去掉 P3 才需要的扩展字段

### 2.2 不包含（明确推迟）
- 多团队目录（P2）
- 协议消息：`shutdown_request/response`、`plan_approval_*`（P3）
- AsyncLocalStorage 上下文隔离（P4）
- 颜色管理（P4）
- `plan_mode_required`（P4）
- UDS / bridge 跨进程或跨机消息（明确不做，YAGNI）
- 旧 `.jsonl` 文件迁移兼容（北哥同意废弃）

## 3. 设计

### 3.1 数据结构

`src/team-types.ts`：

```ts
export type MailboxMessage = {
  from: string
  text: string
  timestamp: string  // ISO 8601
  read: boolean
  color?: string     // 字段先占位，P4 才填值
  summary?: string   // 字段先占位，P4 才填值
}
```

**删除**：
- `MailboxMessageType`（联合类型）
- `MailboxEventType`（联合类型）
- `MailboxMessage` 中的 `id / type / eventType / to / content / taskId / threadId / payload` 字段

字段语义对照（旧 → 新）：
- `content` → `text`
- `id`：删（CC 不维护消息 ID）
- `to`：删（隐含等于文件名）
- 其余扩展字段：删，P3 重做协议消息时用独立 schema

### 3.2 文件布局

P1 阶段路径不动（仍是项目级 `.team/`，P2 才迁到用户级 `~/.claude/teams/{name}/`）。文件后缀和内部格式都换：

```
.team/
  config.json                 # 不动，结构维持 v2
  inbox/
    lead.json                 # JSON 数组：MailboxMessage[]
    {teammate}.json           # 同上
```

启动时 `MessageBus` 构造函数检测到 `inbox/` 下任何 `.jsonl` 文件就直接删除（旧数据废弃，重新建空 `.json`）。

**删除目录**：`.team/events/`（thread 事件历史不再保留，P3 协议消息阶段用独立机制重做）。

### 3.3 `MessageBus` API

```ts
class MessageBus {
  constructor(teamDir: string)

  inboxPath(name: string): string                        // 返回 .json 路径
  ensureInbox(name: string): Promise<void>               // 确保文件存在（空数组）

  send(input: { from: string; to: string; content: string }): Promise<MailboxMessage>
  readUnread(name: string): Promise<MailboxMessage[]>    // 不修改文件，过滤 read=false
  markRead(name: string, messages: MailboxMessage[]): Promise<void>
  unreadCount(name: string): Promise<number>
  readAll(name: string): Promise<MailboxMessage[]>       // 调试用，返回全量含已读

  onSend(to: string, listener: () => void): () => void   // 注册收件人事件，返回 unregister
}
```

实现要点：
- 所有读改写都用 `proper-lockfile` 包裹同一文件路径
- 锁参数：`{ retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } }`（CC 同款）
- `send` 流程：lock → readFile → JSON.parse → 数组 push 一条新消息（`read: false`）→ writeFile → unlock
- `markRead` 流程：lock → readFile → 找到匹配 `(from, timestamp)` 的条目改 `read=true` → writeFile → unlock。匹配键用 `from + timestamp`（`MailboxMessage` 没有 ID）
- `readUnread` / `readAll` / `unreadCount` 不加锁（读旧快照即可，并发写入最差就是看不到最新一条，下次再读就有了）
- 文件不存在 / 内容为空时 `readAll` 返回 `[]`
- `onSend`：内部维护 `Map<string, Set<() => void>>`，`send` 完成（写盘后）触发对应 `to` 的所有 listener。同一个 listener 可重复注册不同 `to`。返回 `unregister` 函数

**删除的 API**：
- `drainInbox`
- `readInbox`（同步版本，原本同名 sync）
- `inboxSize`（同步版本）
- `appendThreadEvent / threadPath / readThread`
- `eventDir` 字段
- 模块级导出 `renderInboxPrompt`、`formatMailboxMessages`

### 3.4 注入格式

新增模块级函数：

```ts
export function formatTeammateMessages(messages: MailboxMessage[]): string {
  if (messages.length === 0) return ""
  return messages
    .map(m => {
      const colorAttr = m.color ? ` color="${m.color}"` : ""
      const summaryAttr = m.summary ? ` summary="${m.summary}"` : ""
      return `<teammate-message teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</teammate-message>`
    })
    .join("\n\n")
}
```

CC 同款（参考 `claude-code/utils/teammateMailbox.ts:373`）。XML tag 字符串 `teammate-message` 直接硬编码，不再单独抽常量（仅一处使用）。

### 3.5 Lead 自动连续回合

`src/index.tsx` 主流程重构。抽出 helper：

```text
async function runOneTurn(userQuery: string, ctx) {
  unread = await messageBus.readUnread("lead")
  if (unread.length > 0) {
    await messageBus.markRead("lead", unread)
    pushMessage("system", `(injecting ${unread.length} teammate message(s))`)
    inbox = formatTeammateMessages(unread)
  }

  effectiveQuery = userQuery && inbox
    ? `${inbox}\n\n${userQuery}`
    : userQuery || inbox

  await runAgentTurn(effectiveQuery, ...)
}
```

调用方两条路径：

**路径 A — 用户主动提交**（`submitInput`）：
```text
push user message to UI
await runOneTurn(trimmed, ctx)
// 自动续轮
while (!aborted && (await messageBus.unreadCount("lead")) > 0) {
  pushMessage("system", `(continuing turn for teammate message(s))`)
  await runOneTurn("", ctx)
}
```

**路径 B — Lead idle 时被新消息唤醒**：

CC 的 in-process teammate 之所以「自动投递」，是因为 send 时直接调用接收方的 wake 回调（同进程函数调用）。Lead 也要享受同等待遇：

- `MessageBus.send` 增加一个 listener 注册机制：`onSend(to: string, callback: () => void)`，`send` 时若 `to` 已注册 listener 就调用之
- `index.tsx` 启动时注册 `onSend("lead", () => triggerLeadAutoTurn())`
- `triggerLeadAutoTurn`：
  - 如果当前正在 turn 中（`busy === true`），不做事（路径 A 的 while 兜底，turn 结束后会消化）
  - 如果当前空闲（`busy === false` 且无 pending submit），调用 `runOneTurn("")` 走一轮，跑完后再走 while 续轮
- 用 `triggerLeadAutoTurnRef` 互斥：防止 listener 触发后正在跑、又来新消息再次进入造成重入

这样无论用户在不在键盘前，只要 lead session 运行着，队友消息都能被消化——与 CC 「lead session 活着就持续运行」一致。

**中断**：复用现有 `AbortController`。`runAgentTurn` 抛 `turn-interrupted` 异常时跳出 while。中断时已 `markRead` 的消息保留 `read=true`（不回滚）——这是有意取舍，避免 lead 重启后重复处理；用户能从 UI 历史看到上一轮注入了什么。

**停止条件**：`unreadCount("lead") === 0` 时立即停止 while（A 选项严格 CC，无熔断）。

### 3.6 Teammate Loop

`src/agent.ts` 的 `runTeammateLoopResponses / runTeammateLoopChatCompletions`：

```text
原: const inbox = messageBus.drainInbox(control.name)
新: const inbox = await messageBus.readUnread(control.name)
    if (inbox.length > 0) await messageBus.markRead(control.name, inbox)
```

注入内容用 `formatTeammateMessages(inbox)`，与 lead 一致（CC 不区分上下行 tag，统一 `<teammate-message>`）。

`src/teammate-manager.ts:277` 的唤醒判定：
```text
原: this.messageBus.inboxSize(control.name) > 0
新: (await this.messageBus.unreadCount(control.name)) > 0
```

`waitForWake` 方法签名加 `async`。`teammate-manager.ts:311` 的 `formatTeamStatus` 中 `inboxSize` 调用同步改 await（方法本身改 async，调用方 `index.tsx:680` 跟着 await）。

### 3.7 工具变更

`src/tools.ts`：

| 工具 | 改动 |
|---|---|
| `lead_inbox` | **删除**：tool 定义 + handler + 在 `LEAD_TOOLS` 中的引用 |
| `message_send` | 入参字段从 `to / content / type / event_type / task_id / thread_id / payload` 简化为 `to / content`（schema 和 handler 同步），handler 内部把 `content` 映射成 `text` 写入新 MailboxMessage |
| `teammate_list` | 输出里 `inbox=N` 含义改成 unreadCount，调用 `await messageBus.unreadCount(name)` |

`teammate-manager.ts:formatTeamStatus` 同步改 async，调用方（含 `index.tsx:680` 的状态行）跟着 await。

`buildSharedTeamHandlers`（`agent.ts:924`）签名同步简化。

### 3.8 supervisor / lead_inbox 处理逻辑

`src/index.tsx` 中：
- `processLeadInboxEvents`（依赖 `eventType / taskId`）：**删除**（P3 重做）
- `buildLeadInboxQuery`：**合并**进 §3.5 的 `runOneTurn` helper，原函数删除
- `submitInput` 中 drain lead inbox 的逻辑（`index.tsx:1833-1844`）整体被 `runOneTurn` 替换

### 3.9 UI

- 状态行（`index.tsx:680`）：`lead inbox: N` 中 N 改 `unreadCount("lead")`
- 自动续轮时 push 一条 `system` 消息 `(continuing turn for teammate message(s))`，让用户知道 lead 在自跑
- 注入消息时 push `(injecting N teammate message(s))`

## 4. 依赖变更

`code-agent/package.json` 加：
```json
"proper-lockfile": "^4.1.2"
```

附 `@types/proper-lockfile`。

## 5. 删除清单

| 文件 | 删除项 |
|---|---|
| `src/message-bus.ts` | `drainInbox` / `readInbox(sync)` / `inboxSize(sync)` / `appendThreadEvent` / `threadPath` / `readThread` / `eventDir` 字段 / `renderInboxPrompt` / `formatMailboxMessages` |
| `src/team-types.ts` | `MailboxMessageType` / `MailboxEventType` / 旧 `MailboxMessage` 扩展字段 |
| `src/tools.ts` | `lead_inbox` 工具定义和 handler；`message_send` 中扩展字段 |
| `src/agent.ts` | `drainInbox` 所有调用点；`buildSharedTeamHandlers` 中扩展字段映射 |
| `src/tools.ts:task_complete/task_block/task_fail` | 删除内部 `messageBus.send` 调用（这些是协议消息雏形，P3 用独立 schema 重做）。Task manager 状态写入保留 |
| `src/index.tsx` | `processLeadInboxEvents` / `buildLeadInboxQuery`（如果定义在此）；`messageBus.drainInbox("lead")` 调用 |
| 文件系统 | `.team/events/` 整个目录；启动时删除 `.team/inbox/*.jsonl` |

## 6. 测试场景

1. **基础投递**：alice 通过 `message_send` 给 lead 发一条 → `.team/inbox/lead.json` 多一条 `read=false` 的条目
2. **自动续轮**：lead 第一轮跑到一半，alice 发消息；lead 第一轮结束后立刻开第二轮，注入这条消息；如果第二轮 alice 又发，第三轮继续
3. **多消息合并**：lead 跑一轮期间 alice 和 bob 各发 1 条 → 第二轮开始时一次性注入 2 条（同一个 `<teammate-message>` 块拼起来）
4. **用户输入合并**：用户提交「修一下 X」时，lead 邮箱有 3 条未读 → 一次性注入「3 条 + 用户 query」
5. **Ctrl+C 中断**：自动续轮第 2 轮中按 Ctrl+C → 立即停止；中断时未发的消息保持 `read=false`，已注入的保持 `read=true`
6. **历史保留**：跑完几轮后 cat `.team/inbox/lead.json` 能看到全部历史消息及读未读状态
7. **并发写**：模拟两个 teammate 同时给 lead 发消息（构造测试用并发 send）→ 两条都落盘，无丢失（lockfile 生效）
8. **旧 jsonl 清理**：手工塞一个 `.team/inbox/lead.jsonl` 启动 → 启动后该文件被删，`lead.json` 是空数组
9. **Teammate 侧**：lead 发消息给 alice，alice idle → alice 醒来 → 注入消息为 `<teammate-message teammate_id="lead">...</teammate-message>` → 处理完消息标记 `read=true`
10. **Teammate 唤醒判定**：alice idle 时 `unreadCount("alice") > 0` 应触发 `wake()`
11. **Lead idle 唤醒**：用户提交完一轮、lead 空闲、不在键盘前；alice 这时发消息 → lead 自动开新一轮注入消息（路径 B）。再发一条 → 当前轮跑完后续轮兜底

## 7. 落地步骤建议（writing-plans 阶段细化）

1. 装 `proper-lockfile` + types
2. 改 `team-types.ts` 简化 `MailboxMessage`
3. 重写 `message-bus.ts`（新 API + 锁 + 启动清理 jsonl）
4. 改 `tools.ts`（删 `lead_inbox`、简化 `message_send`、状态显示）
5. 改 `agent.ts`（teammate loop drain → markRead；删旧 helper）
6. 改 `teammate-manager.ts`（`waitForWake` / `formatTeamStatus` 异步化）
7. 改 `index.tsx`（`runOneTurn` helper + 自动续轮 while + `onSend("lead")` 注册 + `triggerLeadAutoTurn` 互斥逻辑 + UI 提示 + 删 `processLeadInboxEvents` / `buildLeadInboxQuery`）
8. 手测 §6 的 10 个场景

---

## 8. 取舍记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 邮箱文件格式 | JSON 数组 + read 标记 | CC 同款，便于审计 / 重读 |
| 锁库 | proper-lockfile | CC 同款，cross-platform |
| 旧 jsonl 兼容 | 不保留 | 北哥确认废弃，learning project 无线上数据 |
| 自动连续回合 | 严格 CC（无熔断、无用户输入优先） | 北哥要求严格对齐 CC |
| `lead_inbox` 工具 | 删除 | CC 没这个工具；保留会让 lead 学到反习惯 |
| 注入格式 | `<teammate-message>` XML | CC 同款，对话语义优于 JSON |
| MailboxMessage 字段 | 简化到 CC 同款 | 扩展字段（taskId/threadId 等）P3 用独立 schema 重做 |
| 路径 | P1 不迁，仍 `.team/` | 避免和 P2 多团队改动耦合 |
| Thread 事件历史 | 删除 `.team/events/` | P3 协议消息阶段用独立机制 |
| 中断时 markRead 状态 | 不回滚 | 避免重启后重复处理；UI 历史可查注入内容 |
