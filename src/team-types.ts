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
