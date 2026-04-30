# Team Mailbox Overhaul (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `code-agent/` 的邮箱底座从 JSONL+drain 升级到 Claude Code 同款 JSON+`read` 标记+lockfile，让 lead 自动连续接收队友消息。

**Architecture:** 单文件 JSON 数组存全量消息（每条带 `read: boolean`），`proper-lockfile` 串行化并发写入；`MessageBus.onSend` 事件总线让 lead idle 时也能被新消息唤醒；UI 主 loop 用 `runOneTurn` helper + while 续轮实现「严格 CC 同款自动续轮」（无熔断、无用户输入优先）。

**Tech Stack:** TypeScript (NodeNext ESM), Ink/React UI, OpenAI SDK, `node:test` 测试运行器, `proper-lockfile` 文件锁。

**Spec:** `docs/superpowers/specs/2026-04-30-team-mailbox-overhaul-design.md`

**前置说明：**
- 本项目工作目录是 `code-agent/`，所有文件路径均相对此目录（绝对路径以 `/Users/linweimin/codes/agent-learn/claude-code-mini/code-agent/` 为根）
- `code-agent/AGENTS.md` 要求每个方法或重要逻辑都带详细注释（写为什么，不只写做什么）
- 测试用 `node --import tsx --test test/<file>.test.ts` 跑，断言库是 `node:assert/strict`
- 顶层目录不是 git 仓（pwd 非 `.git`）。每个 task 末尾的 commit 步骤如果不在 git 环境下就跳过；如果项目处于 git 仓（执行 `git rev-parse --is-inside-work-tree` 输出 `true`）就照做
- 需要严格 YAGNI：不为 P2/P3/P4 才会用到的功能（多团队、协议消息、AsyncLocalStorage）做铺垫

---

## File Structure

| 文件 | 状态 | 职责 |
|---|---|---|
| `code-agent/src/team-types.ts` | 修改 | 简化 `MailboxMessage`，删旧联合类型 |
| `code-agent/src/message-bus.ts` | 重写 | JSON+lockfile 邮箱核心；`onSend` 事件总线；`formatTeammateMessages` |
| `code-agent/src/tools.ts` | 修改 | 删 `LEAD_INBOX_TOOL`；简化 `TEAM_MESSAGE_TOOL`；`task_complete/block/fail` 中删 `messageBus.send` 调用 |
| `code-agent/src/agent.ts` | 修改 | Teammate loop 用 `readUnread/markRead`；`buildSharedTeamHandlers` 字段简化 |
| `code-agent/src/teammate-manager.ts` | 修改 | `waitForWake / formatTeamStatus` 异步化 |
| `code-agent/src/supervisor.ts` | 删除 | `processLeadInboxEvents` 整体废弃（P3 重做） |
| `code-agent/src/index.tsx` | 修改 | `runOneTurn` helper + 续轮 while + `onSend("lead")` 注册 + UI 提示 + `/inbox` `/task` 命令清理 |
| `code-agent/test/message-bus.test.ts` | 新建 | `MessageBus` 单测 |
| `code-agent/package.json` | 修改 | 加 `proper-lockfile` 和类型 |

---

## Task 1: 安装依赖

**Files:**
- Modify: `code-agent/package.json`

- [ ] **Step 1: 安装 proper-lockfile + 类型**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npm install proper-lockfile@^4.1.2
npm install --save-dev @types/proper-lockfile
```

- [ ] **Step 2: 验证安装**

```bash
node -e "import('proper-lockfile').then(m => console.log(typeof m.lock))"
```

Expected: `function`

- [ ] **Step 3: Commit（如果在 git 仓）**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add package.json package-lock.json && git commit -m "chore: add proper-lockfile for mailbox locking" || echo "(skip: not a git repo)"
```

---

## Task 2: 简化 `team-types.ts` 中的 `MailboxMessage`

**Files:**
- Modify: `code-agent/src/team-types.ts`

- [ ] **Step 1: 完整替换文件内容**

把 `code-agent/src/team-types.ts` 替换为下面内容。注释保留中文，符合项目惯例。

```ts
import type { ChatMessage, ResponseInputItem } from "./types.js";

// 队友状态：与 teammate runtime control 状态机一致。
export type TeamMemberStatus = "working" | "idle" | "blocked" | "stopped" | "error";

// 邮箱消息：参考 Claude Code TeammateMessage 同款字段。
// 之所以删去 id / type / eventType / to / content / taskId / threadId / payload，
// 是因为 P1 阶段只做基础投递；协议消息（shutdown / approval）将在 P3 阶段
// 用独立 schema 重做，不再让 MailboxMessage 同时承担两种职责。
export type MailboxMessage = {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  // 占位字段：P4 颜色管理 / 摘要预览启用时填值，P1/P2/P3 保持空。
  color?: string;
  summary?: string;
};

export type TeammateRecord = {
  name: string;
  role: string;
  status: TeamMemberStatus;
  createdAt: string;
  lastActiveAt: string;
  lastError?: string;
  currentTaskId?: number;
  currentThreadId?: string;
  lastSummary?: string;
};

export type TeamConfig = {
  version: 2;
  leadName: "lead";
  members: TeammateRecord[];
};

export type TeammateRuntimeState = {
  name: string;
  role: string;
  sessionId: string;
  previousResponseId?: string;
  responseHistory: ResponseInputItem[];
  chatHistory: ChatMessage[];
  turnCount: number;
  launchedAt: number;
  roundsSinceTask: number;
  compactCount: number;
  currentTaskId?: number;
  currentThreadId?: string;
  lastSummary?: string;
};
```

- [ ] **Step 2: TypeScript 编译检查**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npx tsc --noEmit 2>&1 | head -40
```

Expected: 大量 error（其它文件还在引用旧字段，预期）。记录 error 数量，后续任务结束后该数会逐步降到 0。

- [ ] **Step 3: Commit**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add src/team-types.ts && git commit -m "refactor(team): simplify MailboxMessage to CC-style fields" || echo "(skip)"
```

---

## Task 3: 重写 `message-bus.ts` —— TDD

整个文件重写。先写单测（红），再实现（绿）。

**Files:**
- Modify: `code-agent/src/message-bus.ts`
- Create: `code-agent/test/message-bus.test.ts`

### Task 3.1: 写失败测试

- [ ] **Step 1: 创建测试文件**

写到 `code-agent/test/message-bus.test.ts`：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageBus, formatTeammateMessages } from "../src/message-bus.js";

function tempTeamDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "team-bus-test-"));
}

test("send 写入新消息为未读", async () => {
  const dir = tempTeamDir();
  const bus = new MessageBus(dir);
  const msg = await bus.send({ from: "alice", to: "lead", content: "hello" });

  assert.equal(msg.from, "alice");
  assert.equal(msg.text, "hello");
  assert.equal(msg.read, false);
  assert.match(msg.timestamp, /^\d{4}-\d{2}-\d{2}T/);

  const all = await bus.readAll("lead");
  assert.equal(all.length, 1);
  assert.equal(all[0].text, "hello");
});

test("readUnread 只返回未读消息", async () => {
  const dir = tempTeamDir();
  const bus = new MessageBus(dir);
  await bus.send({ from: "alice", to: "lead", content: "first" });
  await bus.send({ from: "bob", to: "lead", content: "second" });

  const unread1 = await bus.readUnread("lead");
  assert.equal(unread1.length, 2);

  await bus.markRead("lead", [unread1[0]]);
  const unread2 = await bus.readUnread("lead");
  assert.equal(unread2.length, 1);
  assert.equal(unread2[0].text, "second");

  const all = await bus.readAll("lead");
  assert.equal(all.length, 2);
  assert.equal(all[0].read, true);
  assert.equal(all[1].read, false);
});

test("unreadCount 反映未读数", async () => {
  const dir = tempTeamDir();
  const bus = new MessageBus(dir);
  assert.equal(await bus.unreadCount("lead"), 0);

  await bus.send({ from: "alice", to: "lead", content: "x" });
  await bus.send({ from: "bob", to: "lead", content: "y" });
  assert.equal(await bus.unreadCount("lead"), 2);

  const unread = await bus.readUnread("lead");
  await bus.markRead("lead", unread);
  assert.equal(await bus.unreadCount("lead"), 0);
});

test("不存在的邮箱视为空", async () => {
  const dir = tempTeamDir();
  const bus = new MessageBus(dir);
  assert.deepEqual(await bus.readUnread("nobody"), []);
  assert.equal(await bus.unreadCount("nobody"), 0);
  assert.deepEqual(await bus.readAll("nobody"), []);
});

test("启动时清理旧 jsonl 文件", () => {
  const dir = tempTeamDir();
  const inboxDir = path.join(dir, "inbox");
  fs.mkdirSync(inboxDir, { recursive: true });
  const stalePath = path.join(inboxDir, "lead.jsonl");
  fs.writeFileSync(stalePath, '{"old":"data"}\n', "utf8");

  // 构造 MessageBus 时应该把 .jsonl 删掉
  const _bus = new MessageBus(dir);
  void _bus;

  assert.equal(fs.existsSync(stalePath), false);
});

test("send 触发 onSend listener", async () => {
  const dir = tempTeamDir();
  const bus = new MessageBus(dir);

  const seen: string[] = [];
  const unregister = bus.onSend("lead", () => {
    seen.push("ping");
  });

  await bus.send({ from: "alice", to: "lead", content: "x" });
  assert.deepEqual(seen, ["ping"]);

  await bus.send({ from: "bob", to: "alice", content: "y" });
  assert.deepEqual(seen, ["ping"], "发给 alice 不应触发 lead 的 listener");

  unregister();
  await bus.send({ from: "alice", to: "lead", content: "z" });
  assert.deepEqual(seen, ["ping"], "unregister 后不应再触发");
});

test("formatTeammateMessages 输出 CC 同款 XML", () => {
  const xml = formatTeammateMessages([
    { from: "alice", text: "hi", timestamp: "2026-01-01T00:00:00.000Z", read: false },
    { from: "bob", text: "hey", timestamp: "2026-01-01T00:00:00.000Z", read: false, color: "red", summary: "greeting" },
  ]);

  assert.equal(
    xml,
    [
      '<teammate-message teammate_id="alice">',
      "hi",
      "</teammate-message>",
      "",
      '<teammate-message teammate_id="bob" color="red" summary="greeting">',
      "hey",
      "</teammate-message>",
    ].join("\n"),
  );
});

test("formatTeammateMessages 空数组返回空串", () => {
  assert.equal(formatTeammateMessages([]), "");
});

test("并发 send 不丢消息（lockfile）", async () => {
  const dir = tempTeamDir();
  const bus = new MessageBus(dir);

  const senders = Array.from({ length: 20 }, (_, i) =>
    bus.send({ from: "alice", to: "lead", content: `msg-${i}` }),
  );
  await Promise.all(senders);

  const all = await bus.readAll("lead");
  assert.equal(all.length, 20);
  const texts = all.map((m) => m.text).sort();
  const expected = Array.from({ length: 20 }, (_, i) => `msg-${i}`).sort();
  assert.deepEqual(texts, expected);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
node --import tsx --test test/message-bus.test.ts 2>&1 | head -40
```

Expected: 编译错误或断言失败（旧实现没有 `readUnread / markRead / onSend / formatTeammateMessages`）。

### Task 3.2: 实现新 `message-bus.ts`

- [ ] **Step 3: 完整替换 `code-agent/src/message-bus.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

import type { MailboxMessage } from "./team-types.js";

// 锁参数：参考 Claude Code 的 LOCK_OPTIONS。
// retries.retries=10 + 指数退避避免并发 send 时直接失败；上界 100ms 控制最坏情况。
const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
} as const;

type SendInput = {
  from: string;
  to: string;
  content: string;
};

// 邮箱名只允许字母数字下划线短横线，避免路径注入。
function normalizeMailboxName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`Invalid mailbox name: ${name}`);
  }
  return normalized;
}

function isMailboxMessage(value: unknown): value is MailboxMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MailboxMessage>;
  return (
    typeof candidate.from === "string"
    && typeof candidate.text === "string"
    && typeof candidate.timestamp === "string"
    && typeof candidate.read === "boolean"
  );
}

// 注入文本采用 CC 同款 <teammate-message> XML tag。
// 之所以用 XML 而非 JSON 包裹，是为了让 LLM 把消息当成「另一个角色对你说话」，
// 而不是结构化数据 —— 对话感更强，模型行为更接近 CC。
export function formatTeammateMessages(messages: MailboxMessage[]): string {
  if (messages.length === 0) return "";
  return messages
    .map((m) => {
      const colorAttr = m.color ? ` color="${m.color}"` : "";
      const summaryAttr = m.summary ? ` summary="${m.summary}"` : "";
      return `<teammate-message teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</teammate-message>`;
    })
    .join("\n\n");
}

export class MessageBus {
  readonly teamDir: string;
  readonly inboxDir: string;
  // listener Map：key=收件人名，value=回调集合。
  // 使用 Set 而非数组，便于 unregister 时 O(1) 删除。
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(teamDir: string) {
    this.teamDir = teamDir;
    this.inboxDir = path.join(teamDir, "inbox");
    fs.mkdirSync(this.inboxDir, { recursive: true });
    this.cleanupLegacyJsonl();
  }

  // 启动时一次性清理旧 .jsonl 文件。
  // 北哥确认废弃旧数据，learning project 不需要迁移路径。
  private cleanupLegacyJsonl(): void {
    if (!fs.existsSync(this.inboxDir)) return;
    for (const entry of fs.readdirSync(this.inboxDir)) {
      if (entry.endsWith(".jsonl")) {
        fs.unlinkSync(path.join(this.inboxDir, entry));
      }
    }
  }

  inboxPath(name: string): string {
    return path.join(this.inboxDir, `${normalizeMailboxName(name)}.json`);
  }

  // ensureInbox 必须在加锁前调用；proper-lockfile 要求目标文件已存在。
  async ensureInbox(name: string): Promise<void> {
    const target = this.inboxPath(name);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, "[]", "utf8");
    }
  }

  // 读全量（含已读）。无锁是有意取舍：读快照不影响一致性，
  // 并发写入最坏情况也只是看不到最新一条，下次再读就有了。
  async readAll(name: string): Promise<MailboxMessage[]> {
    const target = this.inboxPath(name);
    if (!fs.existsSync(target)) return [];
    const raw = fs.readFileSync(target, "utf8").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isMailboxMessage);
    } catch {
      return [];
    }
  }

  async readUnread(name: string): Promise<MailboxMessage[]> {
    const all = await this.readAll(name);
    return all.filter((m) => !m.read);
  }

  async unreadCount(name: string): Promise<number> {
    const unread = await this.readUnread(name);
    return unread.length;
  }

  // 加锁的读改写。proper-lockfile.lock 需要目标文件已存在。
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureInbox(name);
    const release = await lockfile.lock(this.inboxPath(name), LOCK_OPTIONS);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async send(input: SendInput): Promise<MailboxMessage> {
    const to = normalizeMailboxName(input.to);
    const message: MailboxMessage = {
      from: normalizeMailboxName(input.from),
      text: input.content,
      timestamp: new Date().toISOString(),
      read: false,
    };

    await this.withLock(to, async () => {
      const all = await this.readAll(to);
      all.push(message);
      fs.writeFileSync(this.inboxPath(to), JSON.stringify(all, null, 2), "utf8");
    });

    // 写盘成功后再触发 listener，避免 listener 拿到「还没真正落盘」的消息。
    const listeners = this.listeners.get(to);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // listener 异常不应影响 send 结果。
        }
      }
    }

    return message;
  }

  // 通过 (from, timestamp) 复合键匹配；MailboxMessage 没有 ID。
  // 实践中同一来源同一毫秒发两条是边界情况，本设计里 send 是串行加锁的，
  // 时间戳分辨率（毫秒）足以区分。
  async markRead(name: string, messages: MailboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const keys = new Set(messages.map((m) => `${m.from}|${m.timestamp}`));
    await this.withLock(name, async () => {
      const all = await this.readAll(name);
      for (const msg of all) {
        if (keys.has(`${msg.from}|${msg.timestamp}`)) {
          msg.read = true;
        }
      }
      fs.writeFileSync(this.inboxPath(name), JSON.stringify(all, null, 2), "utf8");
    });
  }

  // 注册 send(to=name) 时触发的 listener。返回 unregister 闭包。
  // P1 阶段主要让 lead idle 时也能被新消息唤醒（详见 spec §3.5 路径 B）。
  onSend(name: string, listener: () => void): () => void {
    const key = normalizeMailboxName(name);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(key);
      }
    };
  }
}
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
node --import tsx --test test/message-bus.test.ts 2>&1 | tail -20
```

Expected: `# pass 9` `# fail 0`。

- [ ] **Step 5: Commit**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add src/message-bus.ts test/message-bus.test.ts && git commit -m "feat(team): rewrite MessageBus with JSON+read-flag+lockfile" || echo "(skip)"
```

---

## Task 4: 清理 `tools.ts`

**Files:**
- Modify: `code-agent/src/tools.ts`

### Task 4.1: 简化 `TEAM_MESSAGE_TOOL` schema

- [ ] **Step 1: 替换 `TEAM_MESSAGE_TOOL`**

定位 `code-agent/src/tools.ts` 中的 `TEAM_MESSAGE_TOOL` 定义（约 927-949 行），整段替换为：

```ts
// 团队协作消息工具。P1 阶段只保留最小字段：to + content。
// 协议消息（shutdown / approval）将在 P3 用独立工具实现，不再混在 message_send 里。
export const TEAM_MESSAGE_TOOL = {
  type: "function",
  name: "message_send",
  description: "Send an asynchronous message to lead or another teammate.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Target teammate name or 'lead'" },
      content: { type: "string", description: "Message body" },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
} as const;
```

### Task 4.2: 删除 `LEAD_INBOX_TOOL`

- [ ] **Step 2: 删除 `LEAD_INBOX_TOOL` 定义**

定位 `tools.ts` 中 `LEAD_INBOX_TOOL` 定义（约 991-1002 行），整段删除。

- [ ] **Step 3: 从 `TOOLS` 数组移除 `LEAD_INBOX_TOOL` 引用**

定位 `TOOLS` 数组（约 1005-1013 行），删掉 `LEAD_INBOX_TOOL,` 那一行。最终：

```ts
export const TOOLS = [
  ...BASE_TOOLS,
  TASK_TOOL,
  TEAM_MESSAGE_TOOL,
  TEAMMATE_SPAWN_TOOL,
  TEAMMATE_LIST_TOOL,
  TEAMMATE_SHUTDOWN_TOOL,
] as const;
```

### Task 4.3: 删除 `lead_inbox` handler 与 `formatMailboxMessages` import

- [ ] **Step 4: 修改 import 行**

定位 `tools.ts` 顶部 import：

```ts
import { MessageBus, formatMailboxMessages } from "./message-bus.js";
```

替换为（删 `formatMailboxMessages`）：

```ts
import { MessageBus } from "./message-bus.js";
```

- [ ] **Step 5: 删除 `lead_inbox` handler**

定位 `tools.ts:1160`：

```ts
  lead_inbox: ({ drain }) => formatMailboxMessages(drain ? messageBus.drainInbox(LEAD_NAME) : messageBus.readInbox(LEAD_NAME)),
```

整行删除。

### Task 4.4: 清理 `task_complete / task_block / task_fail` 中的 send 调用

`tools.ts:1100-1155` 三个 task 工具内部都在调 `messageBus.send` 带扩展字段。新 send API 只接受 `from/to/content`，要把这三处 send 调用整体删除（task manager 状态写入保留）。

- [ ] **Step 6: 删除 task_complete 中的 send**

定位 `tools.ts:1107-1115`：

```ts
    messageBus.send({
      from: task.assignee ?? LEAD_NAME,
      to: LEAD_NAME,
      type: "message",
      eventType: "task_completed",
      taskId: task.id,
      threadId: task.threadId,
      content: String(result_summary ?? ""),
    });
```

整段删除。

- [ ] **Step 7: 删除 task_block 中的 send**

定位 `tools.ts:1126-1134`：

```ts
    messageBus.send({
      from: task.assignee ?? LEAD_NAME,
      to: LEAD_NAME,
      type: "message",
      eventType: "task_blocked",
      taskId: task.id,
      threadId: task.threadId,
      content: text,
    });
```

整段删除。

- [ ] **Step 8: 删除 task_fail 中的 send**

定位 `tools.ts:1145-1153`：

```ts
    messageBus.send({
      from: task.assignee ?? LEAD_NAME,
      to: LEAD_NAME,
      type: "message",
      eventType: "task_failed",
      taskId: task.id,
      threadId: task.threadId,
      content: text,
    });
```

整段删除。

### Task 4.5: 简化 `message_send` handler

`tools.ts` 中 `message_send` handler 调用 `messageBus.send` 时也可能传 `type / eventType / taskId / threadId / payload`。需要看当前实现，然后简化。

- [ ] **Step 9: 定位 `message_send` handler**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
grep -n '"message_send":\|message_send:' src/tools.ts
```

找到 handler 位置（应在约 1080-1099 行附近）。

- [ ] **Step 10: 把 handler 简化为只接受 to/content**

如果当前实现读 `args.type / args.event_type / args.task_id / args.thread_id / args.payload`，把这些读取删除；调用 `messageBus.send` 时只传 `{ from, to, content }`。

如果该 handler 在 `tools.ts` 之外的位置（比如 `agent.ts` 的 `buildSharedTeamHandlers`），见 Task 5。

- [ ] **Step 11: TS 编译检查**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npx tsc --noEmit 2>&1 | head -40
```

Expected: 错误数比 Task 2 末尾减少。剩余错误应在 `agent.ts / teammate-manager.ts / index.tsx / supervisor.ts` 中。

- [ ] **Step 12: Commit**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add src/tools.ts && git commit -m "refactor(tools): drop lead_inbox + extended message fields" || echo "(skip)"
```

---

## Task 5: 改 `agent.ts`

**Files:**
- Modify: `code-agent/src/agent.ts`

### Task 5.1: Teammate loop 用 readUnread / markRead

- [ ] **Step 1: 修改 `agent.ts:945` 唤醒判定**

旧：

```ts
    if (!teammateManager.shouldStop(control) && messageBus.inboxSize(control.name) === 0) {
```

改为：

```ts
    if (!teammateManager.shouldStop(control) && (await messageBus.unreadCount(control.name)) === 0) {
```

确保所在函数已是 async（应该是的——它在 teammate runtime loop 内）。

- [ ] **Step 2: 修改 `agent.ts:950` drain 调用**

旧：

```ts
    const inbox = messageBus.drainInbox(control.name);
```

改为：

```ts
    const inbox = await messageBus.readUnread(control.name);
    if (inbox.length > 0) {
      await messageBus.markRead(control.name, inbox);
    }
```

### Task 5.2: 注入文本格式

注入 inbox 到队友上下文的代码（在 `agent.ts:950` 紧接的逻辑里，可能用 `renderInboxPrompt` 或类似函数）需要换成 `formatTeammateMessages`。

- [ ] **Step 3: 定位注入代码**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
grep -n "renderInboxPrompt\|formatMailboxMessages" src/agent.ts
```

- [ ] **Step 4: 替换 import 和调用**

如果有 `import { renderInboxPrompt, formatMailboxMessages } from "./message-bus.js"`，改为：

```ts
import { formatTeammateMessages } from "./message-bus.js";
```

所有 `renderInboxPrompt(messages)` 或 `formatMailboxMessages(messages)` 调用换成 `formatTeammateMessages(messages)`。

### Task 5.3: 简化 `buildSharedTeamHandlers`

`agent.ts:924` 的 `buildSharedTeamHandlers` 内 `message_send` handler。

- [ ] **Step 5: 替换 `sendTeamMessage` 函数（agent.ts:860-922）**

整段替换为简化版（只 from/to/content；P1 不支持 broadcast，P3 重做）：

```ts
async function sendTeamMessage(
  from: string,
  to: string,
  content: string,
): Promise<string> {
  const recipient = to.trim();
  const body = content.trim();
  if (!recipient) {
    return "Error: Missing recipient.";
  }
  if (!body) {
    return "Error: Missing content.";
  }

  // P1 阶段只支持点对点投递，不支持 broadcast。
  // 校验收件人合法性：lead 总是合法；teammate 必须存在且在运行。
  if (recipient !== LEAD_NAME) {
    const member = teammateManager.getMember(recipient);
    if (!member) {
      return `Error: Unknown teammate: ${recipient}`;
    }
    if (!teammateManager.isRunning(recipient)) {
      return `Error: Teammate ${recipient} is not running. Spawn or restart it first.`;
    }
  }

  await messageBus.send({ from, to: recipient, content: body });

  // 给 teammate 发的消息要主动 wake，让 idle teammate 立刻处理。
  // 给 lead 发的消息由 MessageBus.onSend("lead") listener 处理（见 index.tsx），
  // 不在此处直接调用，保持 sendTeamMessage 与 UI 解耦。
  if (recipient !== LEAD_NAME) {
    teammateManager.wake(recipient);
  }

  return `Sent message to ${recipient}`;
}
```

- [ ] **Step 6: 替换 `buildSharedTeamHandlers`（agent.ts:924-...）**

把 handler 体改为：

```ts
function buildSharedTeamHandlers(agentName: string): Pick<ToolHandlerMap, "message_send"> {
  return {
    // P1：消息工具只支持 to + content。扩展字段（type/eventType/taskId 等）随 P3 协议消息重做。
    message_send: async ({ to, content }) =>
      sendTeamMessage(agentName, String(to ?? ""), String(content ?? "")),
  };
}
```

- [ ] **Step 6.5: 删除 `normalizeMessageType` / `normalizeEventType` helper**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
grep -n "normalizeMessageType\|normalizeEventType" src/agent.ts
```

定位这两个 helper 的定义并整体删除。它们专为 P3 协议字段服务，P1 不再需要。同时检查并删除文件顶部多余的 import（如 `MailboxEventType / MailboxMessageType`）。

- [ ] **Step 7: TS 编译检查**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npx tsc --noEmit 2>&1 | head -40
```

Expected: 错误数继续减少。剩余应在 `teammate-manager.ts / index.tsx / supervisor.ts`。

- [ ] **Step 8: Commit**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add src/agent.ts && git commit -m "refactor(agent): teammate loop uses readUnread/markRead" || echo "(skip)"
```

---

## Task 6: 改 `teammate-manager.ts` —— 异步化

**Files:**
- Modify: `code-agent/src/teammate-manager.ts`

- [ ] **Step 1: 修改 `waitForWake`**

定位 `teammate-manager.ts:276-284`，旧实现：

```ts
  async waitForWake(control: TeammateRuntimeControl): Promise<void> {
    if (control.stopRequested || this.messageBus.inboxSize(control.name) > 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      control.waiters.add(resolve);
    });
  }
```

改为：

```ts
  async waitForWake(control: TeammateRuntimeControl): Promise<void> {
    // 进入等待前先看一眼未读数：若有未读则不应该睡，直接返回让上层立刻 drain。
    if (control.stopRequested || (await this.messageBus.unreadCount(control.name)) > 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      control.waiters.add(resolve);
    });
  }
```

- [ ] **Step 2: 修改 `formatTeamStatus` 签名为 async**

定位 `teammate-manager.ts:302-319`：

```ts
  formatTeamStatus(): string {
    const members = this.listMembers();
    if (members.length === 0) {
      return `team_dir ${this.teamDir}\n(no teammates)`;
    }

    return [
      `team_dir ${this.teamDir}`,
      ...members.map((member) => {
        const inboxSize = this.messageBus.inboxSize(member.name);
        // ...
      }),
    ].join("\n");
  }
```

改为：

```ts
  async formatTeamStatus(): Promise<string> {
    const members = this.listMembers();
    if (members.length === 0) {
      return `team_dir ${this.teamDir}\n(no teammates)`;
    }

    // 并发查询每个成员的未读数。Promise.all 比 for-await 快。
    const lines = await Promise.all(
      members.map(async (member) => {
        const inboxSize = await this.messageBus.unreadCount(member.name);
        const errorSuffix = member.lastError ? ` error=${member.lastError}` : "";
        const workSuffix = member.currentTaskId ? ` task=${member.currentTaskId}` : "";
        const threadSuffix = member.currentThreadId ? ` thread=${member.currentThreadId}` : "";
        const summarySuffix = member.lastSummary ? ` summary=${member.lastSummary}` : "";
        return `- ${member.name} [${member.status}] role=${member.role} inbox=${inboxSize} last_active=${member.lastActiveAt}${workSuffix}${threadSuffix}${summarySuffix}${errorSuffix}`;
      }),
    );

    return [`team_dir ${this.teamDir}`, ...lines].join("\n");
  }
```

- [ ] **Step 3: 同步更新 `tools.ts` 中的调用方**

`tools.ts:1159` 的 `teammate_list` handler：

```ts
  teammate_list: () => teammateManager.formatTeamStatus(),
```

JS 自动 await Promise 字符串就行，但保险起见明确写：

```ts
  teammate_list: async () => await teammateManager.formatTeamStatus(),
```

- [ ] **Step 4: TS 编译检查**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npx tsc --noEmit 2>&1 | head -40
```

Expected: 剩余错误集中在 `index.tsx / supervisor.ts`。

- [ ] **Step 5: Commit**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add src/teammate-manager.ts src/tools.ts && git commit -m "refactor(team-manager): async waitForWake/formatTeamStatus" || echo "(skip)"
```

---

## Task 7: 删除 `supervisor.ts`

**Files:**
- Delete: `code-agent/src/supervisor.ts`

`supervisor.ts` 中 `processLeadInboxEvents` 整体废弃（依赖被删的 eventType / taskId 字段，P3 用独立机制重做）。

- [ ] **Step 1: 删除文件**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
rm src/supervisor.ts
```

- [ ] **Step 2: 验证没有其他文件再 import**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
grep -rn 'from "\./supervisor' src/ test/ || echo "(clean)"
```

Expected: 仅 `index.tsx:20` 还在 import（Task 8 修）。

- [ ] **Step 3: Commit（先标记，等 Task 8 一并 commit）**

不立即 commit，等 Task 8 改完 `index.tsx` 再合并 commit。

---

## Task 8: 改 `index.tsx` —— 主 loop / 自动续轮 / 命令清理

**Files:**
- Modify: `code-agent/src/index.tsx`

### Task 8.1: 删旧 import

- [ ] **Step 1: 修改 `index.tsx:20`**

旧：

```ts
import { processLeadInboxEvents } from "./supervisor.js";
```

整行删除。

- [ ] **Step 2: 修改 `index.tsx:45`**

旧：

```ts
import { formatMailboxMessages, renderInboxPrompt } from "./message-bus.js";
```

改为：

```ts
import { formatTeammateMessages } from "./message-bus.js";
```

### Task 8.2: 状态行 inbox=N 异步化

- [ ] **Step 3: 替换 `index.tsx:680`**

旧：

```ts
    `team     ${teammateManager.listMembers().length} teammates | lead inbox: ${messageBus.inboxSize("lead")}`,
```

`inboxSize` 已废弃，且这里位于状态构造（可能是 useMemo / useEffect）—— 需要在外层 useEffect 中异步获取并存到 useState。

定位该行附近的 React state 结构。如果这行在 `useMemo` 或纯渲染函数中，需要：

1. 加一个 `const [leadUnread, setLeadUnread] = useState(0)`
2. 加一个 `useEffect(() => { ... }, [...])`，里面用一个 polling（如 1 秒间隔）或在 turn 变化时调 `messageBus.unreadCount("lead")` 并 setLeadUnread
3. 状态行字符串里用 `leadUnread` 替代

具体实现示例：

```ts
const [leadUnread, setLeadUnread] = useState<number>(0);

useEffect(() => {
  let cancelled = false;
  const refresh = async () => {
    const n = await messageBus.unreadCount("lead");
    if (!cancelled) setLeadUnread(n);
  };
  refresh();
  // 监听 onSend("lead")：每次有新消息立刻刷新；
  // 同时配合 turn 结束后的显式刷新（见 Task 8.4 runOneTurn）。
  const unregister = messageBus.onSend("lead", () => {
    void refresh();
  });
  return () => {
    cancelled = true;
    unregister();
  };
}, []);
```

然后状态行：

```ts
    `team     ${teammateManager.listMembers().length} teammates | lead inbox: ${leadUnread}`,
```

### Task 8.3: 删除 `buildLeadInboxQuery`

- [ ] **Step 4: 删除 `index.tsx:849` 的 `buildLeadInboxQuery` 函数**

定位整段 `function buildLeadInboxQuery(...)`，整体删除。其唯一调用点在 `submitInput`（Task 8.4 重写）。

### Task 8.4: 引入 `runOneTurn` helper + 自动续轮

- [ ] **Step 5: 找到 `submitInput` 函数**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
grep -n "submitInput\|async function submit\|const submitInput" src/index.tsx | head -5
```

- [ ] **Step 6: 重构 `submitInput` 主体**

定位 `index.tsx:1820-1860` 附近的当前主体（含 `messageBus.drainInbox("lead")`、`processLeadInboxEvents`、`buildLeadInboxQuery`、`runAgentTurn` 调用）。

新版本结构（保留外层 `pushMessage("user", trimmed)`、`setBusy(true)`、`AbortController` 等不变，只重写 try 块内部 inbox 与 runAgentTurn 调用部分）：

```ts
    try {
      await ensureMcpInitialized();
      await refreshCurrentAuth();

      // 用户输入主轮：合并未读消息 + 用户 query 一起注入。
      await runOneTurn(trimmed, abortController.signal);

      // 严格 CC 自动续轮：邮箱有未读就持续开新轮，直到清空或被中断。
      while (
        !abortController.signal.aborted
        && (await messageBus.unreadCount("lead")) > 0
      ) {
        pushMessage("system", "(continuing turn for teammate message(s))", "inbox");
        await runOneTurn("", abortController.signal);
      }
    } catch (error) {
      // 现有错误处理保留
      ...
    }
```

- [ ] **Step 7: 添加 `runOneTurn` helper 函数**

在 `submitInput` 外部（或同级），添加：

```ts
// 单轮运行入口：把未读 lead 消息 + 用户 query 合并注入，调用 runAgentTurn。
// 之所以拆成 helper：用户主动提交（带 query）和自动续轮（query 为空）走同一段逻辑，避免重复。
async function runOneTurn(userQuery: string, signal: AbortSignal): Promise<void> {
  const unread = await messageBus.readUnread("lead");
  let injected = "";
  if (unread.length > 0) {
    await messageBus.markRead("lead", unread);
    pushMessage("system", `(injecting ${unread.length} teammate message(s))`, "inbox");
    injected = formatTeammateMessages(unread);
  }

  const effectiveQuery = userQuery && injected
    ? `${injected}\n\n${userQuery}`
    : (userQuery || injected);

  if (!effectiveQuery) return;  // 双空：无事可做

  await runAgentTurn(
    agentConfig,
    effectiveQuery,
    agentStateRef.current,
    bridge,
    { signal },
  );

  // turn 结束后立刻刷新 leadUnread 状态（避免等到下次 polling）
  setLeadUnread(await messageBus.unreadCount("lead"));
}
```

注意：`runOneTurn` 引用了 `agentConfig / agentStateRef / bridge / pushMessage / setLeadUnread`。如果它们都是 React 组件作用域内的，把 `runOneTurn` 也放到组件内部（或用 useCallback 包）。

### Task 8.5: 注册 onSend("lead") 自动续轮触发

- [ ] **Step 8: 添加 lead idle 唤醒机制**

在组件内部加：

```ts
const busyRef = useRef(false);
// busy 状态镜像 setBusy 的传入值（在 setBusy 调用处同步更新 busyRef.current）。
// 之所以用 ref：onSend listener 是闭包，state 在闭包里是旧值，ref 始终最新。

useEffect(() => {
  const unregister = messageBus.onSend("lead", () => {
    // listener 在 send 完成后触发；此时 busy 状态是真实的「lead 是否正在跑」。
    // - busy=true：当前轮还没结束，let path A 的 while 兜底；不要重入。
    // - busy=false：lead 空闲，主动开一轮。
    if (busyRef.current) return;
    void triggerLeadAutoTurn();
  });
  return unregister;
}, []);

async function triggerLeadAutoTurn(): Promise<void> {
  if (busyRef.current) return;
  if ((await messageBus.unreadCount("lead")) === 0) return;
  setBusy(true);
  busyRef.current = true;
  const abortController = new AbortController();
  activeTurnAbortRef.current = abortController;
  try {
    // 第一轮 + 续轮（与 submitInput 一致的循环结构）
    await runOneTurn("", abortController.signal);
    while (!abortController.signal.aborted && (await messageBus.unreadCount("lead")) > 0) {
      pushMessage("system", "(continuing turn for teammate message(s))", "inbox");
      await runOneTurn("", abortController.signal);
    }
  } catch (error) {
    finalizeStreaming();
    if (isTurnInterruptedError(error)) {
      pushMessage("system", "Stopped current turn. Session context preserved.", "stop");
    } else {
      pushMessage("error", error instanceof Error ? error.message : String(error), "error");
    }
  } finally {
    finalizeStreaming();
    persistCurrentSession();
    setBusy(false);
    busyRef.current = false;
  }
}
```

同时，在所有 `setBusy(...)` 调用处同步更新 `busyRef.current`（搜 `setBusy(` 把每处加上 `busyRef.current = <true|false>`）。

### Task 8.6: 清理 `/inbox` 命令

- [ ] **Step 9: 替换 `index.tsx:1557-1560`**

旧：

```ts
      if (command === "inbox") {
        pushMessage("system", formatMailboxMessages(messageBus.drainInbox("lead")), "inbox");
        return;
      }
```

新（变成只读：列出已读 + 未读全部历史，不修改文件）：

```ts
      if (command === "inbox") {
        // P1 后邮箱保留全部历史；/inbox 改为只读视图，便于调试。
        // 注：自动注入由 runOneTurn 在新一轮开始时处理，不需要用户手动 drain。
        const all = await messageBus.readAll("lead");
        const formatted = all.length === 0
          ? "(empty inbox)"
          : all
              .map((m) => `[${m.timestamp}] ${m.from} ${m.read ? "(read)" : "(UNREAD)"}\n${m.text}`)
              .join("\n\n");
        pushMessage("system", formatted, "inbox");
        return;
      }
```

确认外层函数是 async（命令处理通常是）。

### Task 8.7: 清理 `/task <id>` 命令中的 thread 部分

- [ ] **Step 10: 替换 `index.tsx:1543-1551`**

旧：

```ts
        const threadMessages = task.threadId ? messageBus.readThread(task.threadId) : [];
        const detail = [
          taskManager.formatTask(taskId),
          "",
          `thread_events=${threadMessages.length}`,
          ...(threadMessages.length > 0
            ? ["", formatMailboxMessages(threadMessages.slice(-20))]
            : []),
        ].join("\n");
```

新（thread 历史在 P1 已废弃；P3 协议消息会用独立机制）：

```ts
        // P1 阶段不再保留 thread 事件历史。task 详情仅显示 task manager 的状态。
        // P3 协议消息阶段如果需要事件审计，会用独立机制（不复用 mailbox）。
        const detail = taskManager.formatTask(taskId);
```

### Task 8.8: 编译并 commit

- [ ] **Step 11: TS 编译检查**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npx tsc --noEmit 2>&1 | head -40
```

Expected: 0 error。如还有错误，根据提示修。

- [ ] **Step 12: 跑全套测试**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npm test 2>&1 | tail -20
```

Expected: 全绿。

- [ ] **Step 13: Commit**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add -A && git commit -m "refactor(ui): runOneTurn + auto-continuation + onSend(lead)" || echo "(skip)"
```

---

## Task 9: 端到端手测（spec §6 全部 11 个场景）

**Files:** 无（仅运行）

- [ ] **Step 1: 准备干净环境**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
rm -rf .team
```

- [ ] **Step 2: 启动 dev 模式**

```bash
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npm run dev
```

- [ ] **Step 3: 场景 1 — 基础投递**

在 CLI 中运行：

```
Spawn a teammate named alice with role coder. Initial prompt: "say hi".
```

期望：alice spawn 成功，`.team/inbox/alice.json` 是 `[]` 或包含初始 prompt 消息。`.team/inbox/lead.json` 存在。alice 处理完会给 lead 发一条消息。

验证：

```bash
cat .team/inbox/lead.json
```

应该看到 alice 发来的消息，`read` 字段为 `true`（lead 已自动消费）或 `false`（如果 alice 发完 lead 还没开新轮）。

- [ ] **Step 4: 场景 2 — 自动续轮**

```
Tell alice to count from 1 to 5 and send each number as a separate message to lead.
```

期望：lead 第一轮发出指令后结束。alice 会发 5 条消息，lead 自动开 5 轮（或在某轮一次注入多条），CLI 上每次自动续轮显示 `(continuing turn for teammate message(s))`。

- [ ] **Step 5: 场景 3 — 多消息合并**

```
Spawn a second teammate bob with role reviewer. Tell alice and bob to each send one message to lead simultaneously.
```

期望：lead 第一轮（指令）结束后开第二轮，同时注入 alice 和 bob 的两条消息（一个 `<teammate-message>` 块拼出 2 段）。

- [ ] **Step 6: 场景 4 — 用户输入合并**

让 alice 给 lead 发 3 条消息，期间不要让 lead 自动续轮跑完（可以快速输入新 query）。当 lead 邮箱有未读时，键入：

```
What did alice say?
```

期望：lead 收到的轮次输入是「3 条 teammate-message + What did alice say?」。

- [ ] **Step 7: 场景 5 — Ctrl+C 中断**

在自动续轮第 2 轮中按 Ctrl+C。

期望：立即停止；`cat .team/inbox/lead.json` 看到部分消息 `read=true`（已注入的）+ 部分 `read=false`（被中断未及处理的，会在下次触发时再注入）。

- [ ] **Step 8: 场景 6 — 历史保留**

跑完前面几轮后查看：

```bash
cat .team/inbox/lead.json | jq '.[] | {from, text, read}'
```

期望：能看到全部历史消息，已读和未读都在。

- [ ] **Step 9: 场景 7 — 并发写**

在两个 teammate 同时给 lead 发消息的 dialog 完成后：

```bash
cat .team/inbox/lead.json | jq 'length'
```

期望：`length` 等于实际发送总数，无消息丢失。

- [ ] **Step 10: 场景 8 — 旧 jsonl 清理**

退出 CLI 后：

```bash
echo '{"old": "data"}' > .team/inbox/lead.jsonl
cd /Users/linweimin/codes/agent-learn/claude-code-mini/code-agent
npm run dev
```

期望：启动后 `.team/inbox/lead.jsonl` 不再存在；`.team/inbox/lead.json` 是合法 JSON 数组（空或保留之前历史）。

- [ ] **Step 11: 场景 9 — Teammate 侧投递**

```
Send alice the message: "stop counting".
```

期望：alice 收到 `<teammate-message teammate_id="lead">stop counting</teammate-message>`。`.team/inbox/alice.json` 中该条消息 `read=true`。

- [ ] **Step 12: 场景 10 — Teammate 唤醒判定**

让 alice 进入 idle，确认 idle 后给 alice 发新消息（`message_send to=alice`），期望 alice 立刻 wake 处理（CLI 状态行能看到 alice 从 idle → working）。

- [ ] **Step 13: 场景 11 — Lead idle 唤醒**

让 lead 完全完成所有轮次（邮箱清空，进入「等用户输入」状态）。**不要键入任何东西。**让 alice 在 idle 状态主动发一条消息给 lead（可以通过让 alice 此前的工作有延迟回复机制，或者手动用另一个 CLI 实例 echo 一条到 alice 的 inbox 让 alice 投递）。

期望：lead 自动开一轮，注入这条消息，无用户输入触发。

如果 11 条全过，P1 完成。

- [ ] **Step 14: 最终 commit**

```bash
git rev-parse --is-inside-work-tree 2>/dev/null && git add -A && git commit -m "test: P1 mailbox overhaul end-to-end manual verification" || echo "(skip)"
```

---

## Self-Review 备忘

写完该 plan 后已自查：
- ✅ Spec §3.1 ~ §3.9 每节都有对应 task：§3.1→T2, §3.2→T3, §3.3→T3, §3.4→T3, §3.5→T8.4-8.5, §3.6→T5, §3.7→T4+T6, §3.8→T7+T8.3, §3.9→T8.2+T8.4
- ✅ Spec §5 删除清单：每项有 task 覆盖（T2/T3/T4/T5/T6/T7/T8）
- ✅ Spec §6 全 11 测试场景都进了 T9
- ✅ Spec 补丁 `task_complete/block/fail` send 调用在 T4.4 处理
- ✅ 所有 method 名一致：`readUnread / markRead / unreadCount / readAll / send / onSend / formatTeammateMessages` 在 T3 定义后被 T4/T5/T6/T8 一致使用
- ✅ 无 placeholder（无 TBD/TODO/「类似上面」之类的占位）
