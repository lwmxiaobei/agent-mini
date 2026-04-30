import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

import type { MailboxMessage } from "./team-types.js";

// 锁参数：CC 同款 LOCK_OPTIONS。
// retries.retries=10 + 指数退避避免并发 send 时直接失败；上界 100ms 控制最坏情况。
// CC 真实使用中并发量不会非常大（团队几个 agent），10 次重试足够。
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
