import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type { AgentState, PersistedUiMessage } from "./types.js";

export type SessionSnapshot = {
  state: AgentState;
  messages: PersistedUiMessage[];
  providerName?: string;
  model?: string;
  apiMode?: "responses" | "chat-completions";
  savedAt: string;
};

type SessionMetaEntry = {
  kind: "meta";
  sessionId: string;
  workspace: string;
  createdAt: string;
};

type SessionCheckpointEntry = {
  kind: "checkpoint";
  sessionId: string;
  savedAt: string;
  snapshot: SessionSnapshot;
};

type SessionLogEntry = SessionMetaEntry | SessionCheckpointEntry;

export type SessionListItem = {
  sessionId: string;
  savedAt: string;
  createdAt: string;
  title: string;
  turnCount: number;
  model?: string;
  providerName?: string;
};

const XB_CONFIG_DIR = path.join(os.homedir(), ".xbcode");

/**
 * 返回 session transcript 的根目录。
 *
 * 为什么支持环境变量覆写：
 * - 生产环境默认仍然应该落在 `~/.xbcode/sessions`，方便和 settings 放在一起。
 * - 测试和受限沙箱里，home 目录不一定可写，硬编码会让本地持久化能力无法验证。
 * - 用一个集中 helper 做覆写点，可以避免把“测试专用路径”散落到业务逻辑里。
 */
function getSessionRootDir(): string {
  const override = process.env.XBCODE_SESSION_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(XB_CONFIG_DIR, "sessions");
}

/**
 * 为 CLI 会话生成一个可读且稳定的本地 ID。
 *
 * 为什么不用纯随机 UUID：
 * - 会话 ID 会直接展示给用户做 `/resume <id>`，太长会明显影响可输入性。
 * - 我们仍然需要足够低的冲突概率，因此保留时间戳前缀，再拼接短随机串。
 * - 这个 ID 只用于本地文件命名和恢复，不承担安全边界，所以短 ID 足够。
 */
export function createSessionId(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${timestamp}-${suffix}`;
}

/**
 * 计算当前 workspace 对应的 session 目录。
 *
 * 为什么要按 workspace 分目录：
 * - Claude Code 的 transcript 恢复是“当前项目视角”的；用户恢复时只应该看到
 *   当前工程下的历史会话，而不是所有项目的混合列表。
 * - 目录名如果直接使用绝对路径会包含斜杠和空格，不适合作为文件系统路径。
 * - 这里保留 basename 方便人工识别，再拼接 hash 保证不同同名目录不冲突。
 */
function getWorkspaceSessionDir(workspace: string): string {
  const base = path.basename(workspace) || "workspace";
  const safeBase = base.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const hash = crypto.createHash("sha1").update(workspace).digest("hex").slice(0, 12);
  return path.join(getSessionRootDir(), `${safeBase}-${hash}`);
}

/**
 * 返回某个 session 对应的 JSONL transcript 路径。
 *
 * 为什么统一通过 helper：
 * - 创建、列出、恢复都会用到同一套路径规则，集中在这里可以避免散落的拼接逻辑。
 * - 未来如果要把单文件拆成目录结构，只需要改这一处，不必全局替换。
 */
function getSessionPath(workspace: string, sessionId: string): string {
  return path.join(getWorkspaceSessionDir(workspace), `${sessionId}.jsonl`);
}

/**
 * 以追加写方式持久化当前会话快照。
 *
 * 为什么选择 append-only JSONL 而不是反复覆盖一个 JSON：
 * - 这和 Claude Code 的 transcript 思路一致，写入路径更简单，也更抗意外中断。
 * - 追加一行比重写整个文件更稳妥，尤其是在消息越来越多之后。
 * - 当前实现只在 checkpoint 级别恢复，因此读取时只需要最后一个 checkpoint，
 *   但保留历史增量可以给后续调试和回溯留下空间。
 */
export function appendSessionCheckpoint(workspace: string, snapshot: SessionSnapshot): void {
  const filePath = getSessionPath(workspace, snapshot.state.sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    const meta: SessionMetaEntry = {
      kind: "meta",
      sessionId: snapshot.state.sessionId,
      workspace,
      createdAt: new Date(snapshot.state.launchedAt).toISOString(),
    };
    fs.appendFileSync(filePath, `${JSON.stringify(meta)}\n`, "utf8");
  }

  const entry: SessionCheckpointEntry = {
    kind: "checkpoint",
    sessionId: snapshot.state.sessionId,
    savedAt: snapshot.savedAt,
    snapshot,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * 读取当前 workspace 下最近的历史会话摘要。
 *
 * 为什么这里接受“读全文件再找最后 checkpoint”的简化实现：
 * - `code-agent` 目前还没有 Claude Code 那种超大 transcript 和分页恢复需求。
 * - 先把恢复闭环做通，比过早引入 head/tail 扫描、锁文件、lite metadata 更重要。
 * - 当 session 文件明显变大时，再把这里替换成轻量扫描即可，不影响上层接口。
 */
export function listRecentSessions(workspace: string, limit = 10): SessionListItem[] {
  const dir = getWorkspaceSessionDir(workspace);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const items: SessionListItem[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const loaded = loadSessionFromFile(path.join(dir, entry.name));
    if (!loaded) {
      continue;
    }

    const title = extractSessionTitle(loaded.snapshot.messages);
    items.push({
      sessionId: loaded.snapshot.state.sessionId,
      createdAt: loaded.createdAt,
      savedAt: loaded.snapshot.savedAt,
      title,
      turnCount: loaded.snapshot.state.turnCount,
      model: loaded.snapshot.model,
      providerName: loaded.snapshot.providerName,
    });
  }

  return items
    .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
    .slice(0, Math.max(0, limit));
}

/**
 * 加载一个指定的历史会话，并返回最后一次 checkpoint。
 *
 * 为什么只恢复最后 checkpoint：
 * - 当前恢复目标是“把模型上下文和界面消息恢复到可继续工作的最近状态”。
 * - 既然 checkpoint 已经包含完整 `AgentState` 和 UI 消息，就没有必要重放整个日志。
 * - 这也让恢复过程保持确定性，避免中途存在半写入流式消息时的复杂合并。
 */
export function loadSession(workspace: string, sessionId: string): SessionSnapshot | null {
  const filePath = getSessionPath(workspace, sessionId);
  const loaded = loadSessionFromFile(filePath);
  return loaded?.snapshot ?? null;
}

function loadSessionFromFile(filePath: string): { createdAt: string; snapshot: SessionSnapshot } | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    let createdAt = "";
    let lastSnapshot: SessionSnapshot | null = null;

    for (const line of lines) {
      const parsed = JSON.parse(line) as SessionLogEntry;
      if (parsed.kind === "meta") {
        createdAt = parsed.createdAt;
        continue;
      }
      if (parsed.kind === "checkpoint") {
        lastSnapshot = parsed.snapshot;
      }
    }

    if (!lastSnapshot) {
      return null;
    }

    return {
      createdAt: createdAt || new Date(lastSnapshot.state.launchedAt).toISOString(),
      snapshot: lastSnapshot,
    };
  } catch {
    return null;
  }
}

/**
 * 从已持久化消息里提取会话标题。
 *
 * 为什么优先看第一条用户消息：
 * - Claude Code 在 session 列表里也依赖“第一条有意义的用户输入”来帮助识别会话。
 * - 这比模型自动命名更稳定，也不需要额外一次生成或保存专门标题字段。
 * - 工具、系统提示、thinking 内容都不是用户真正想恢复的主题，所以应跳过。
 */
function extractSessionTitle(messages: PersistedUiMessage[]): string {
  for (const message of messages) {
    if (message.kind !== "user") {
      continue;
    }

    const compact = message.text.replaceAll(/\s+/g, " ").trim();
    if (!compact) {
      continue;
    }

    return compact.length > 80 ? `${compact.slice(0, 80).trim()}...` : compact;
  }

  return "(untitled session)";
}
