import fs from "node:fs";
import path from "node:path";

import { MessageBus } from "./message-bus.js";
import { createSessionId } from "./session-store.js";
import type { TeamConfig, TeamMemberStatus, TeammateRecord, TeammateRuntimeState } from "./team-types.js";

export type TeammateRuntimeControl = {
  name: string;
  role: string;
  stopRequested: boolean;
  waiters: Set<() => void>;
  running?: Promise<void>;
  state: TeammateRuntimeState;
};

type RuntimeRunner = (control: TeammateRuntimeControl) => Promise<void>;

function sortMembers(members: TeammateRecord[]): TeammateRecord[] {
  return [...members].sort((left, right) => left.name.localeCompare(right.name));
}

export class TeammateManager {
  private readonly configPath: string;
  private readonly runtimeControls = new Map<string, TeammateRuntimeControl>();

  constructor(
    readonly teamDir: string,
    private readonly messageBus: MessageBus,
    private readonly leadName: "lead" = "lead",
  ) {
    fs.mkdirSync(this.teamDir, { recursive: true });
    this.configPath = path.join(this.teamDir, "config.json");
    this.ensureConfig();
    this.messageBus.ensureInbox(this.leadName);
    this.resetEphemeralStatuses();
  }

  getLeadName(): "lead" {
    return this.leadName;
  }

  private defaultConfig(): TeamConfig {
    return {
      version: 2,
      leadName: this.leadName,
      members: [],
    };
  }

  private ensureConfig(): void {
    if (fs.existsSync(this.configPath)) {
      return;
    }

    fs.writeFileSync(this.configPath, `${JSON.stringify(this.defaultConfig(), null, 2)}\n`, "utf8");
  }

  private loadConfig(): TeamConfig {
    this.ensureConfig();
    try {
      const content = fs.readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(content) as Partial<TeamConfig>;
      return {
        version: 2,
        leadName: this.leadName,
        members: Array.isArray(parsed.members) ? sortMembers(parsed.members as TeammateRecord[]) : [],
      };
    } catch {
      return this.defaultConfig();
    }
  }

  private saveConfig(config: TeamConfig): void {
    const normalized: TeamConfig = {
      version: 2,
      leadName: this.leadName,
      members: sortMembers(config.members),
    };
    fs.writeFileSync(this.configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }

  private resetEphemeralStatuses(): void {
    const config = this.loadConfig();
    let changed = false;

    for (const member of config.members) {
      if (member.status !== "stopped") {
        member.status = "stopped";
        member.currentTaskId = undefined;
        member.currentThreadId = undefined;
        changed = true;
      }
    }

    if (changed) {
      this.saveConfig(config);
    }
  }

  private createRuntimeState(name: string, role: string): TeammateRuntimeState {
    return {
      name,
      role,
      sessionId: createSessionId(),
      responseHistory: [],
      chatHistory: [],
      turnCount: 0,
      launchedAt: Date.now(),
      roundsSinceTask: 0,
      compactCount: 0,
    };
  }

  listMembers(): TeammateRecord[] {
    return this.loadConfig().members;
  }

  getMember(name: string): TeammateRecord | undefined {
    return this.listMembers().find((member) => member.name === name);
  }

  ensureMember(name: string, role: string): TeammateRecord {
    const now = new Date().toISOString();
    const config = this.loadConfig();
    const existing = config.members.find((member) => member.name === name);

    if (existing) {
      existing.role = role;
      existing.lastActiveAt = now;
      existing.lastError = undefined;
      if (existing.status === "error" || existing.status === "stopped") {
        existing.status = "idle";
      }
      this.saveConfig(config);
      this.messageBus.ensureInbox(name);
      return existing;
    }

    const member: TeammateRecord = {
      name,
      role,
      status: "idle",
      createdAt: now,
      lastActiveAt: now,
    };

    config.members.push(member);
    this.saveConfig(config);
    this.messageBus.ensureInbox(name);
    return member;
  }

  setStatus(name: string, status: TeamMemberStatus, lastError?: string): void {
    const config = this.loadConfig();
    const member = config.members.find((entry) => entry.name === name);
    if (!member) {
      return;
    }

    member.status = status;
    member.lastActiveAt = new Date().toISOString();
    if (lastError) {
      member.lastError = lastError;
    } else if (status !== "error") {
      member.lastError = undefined;
    }

    if (status === "idle" || status === "stopped") {
      member.currentTaskId = undefined;
      member.currentThreadId = undefined;
    }

    this.saveConfig(config);
  }

  setCurrentWork(name: string, taskId?: number, threadId?: string, summary?: string): void {
    const config = this.loadConfig();
    const member = config.members.find((entry) => entry.name === name);
    if (!member) {
      return;
    }

    member.lastActiveAt = new Date().toISOString();
    member.currentTaskId = taskId;
    member.currentThreadId = threadId;
    if (typeof summary === "string") {
      member.lastSummary = summary;
    }
    this.saveConfig(config);
  }

  markWorking(name: string): void {
    this.setStatus(name, "working");
  }

  markBlocked(name: string, summary?: string): void {
    this.setStatus(name, "blocked");
    if (summary) {
      this.setCurrentWork(name, this.getMember(name)?.currentTaskId, this.getMember(name)?.currentThreadId, summary);
    }
  }

  markIdle(name: string): void {
    this.setStatus(name, "idle");
  }

  markStopped(name: string): void {
    this.setStatus(name, "stopped");
  }

  markError(name: string, message: string): void {
    this.setStatus(name, "error", message);
  }

  isRunning(name: string): boolean {
    return Boolean(this.runtimeControls.get(name)?.running);
  }

  startRuntime(name: string, role: string, runner: RuntimeRunner): { started: boolean; control: TeammateRuntimeControl } {
    const current = this.runtimeControls.get(name);
    if (current?.running) {
      return { started: false, control: current };
    }

    const control: TeammateRuntimeControl = {
      name,
      role,
      stopRequested: false,
      waiters: new Set(),
      running: undefined,
      state: this.createRuntimeState(name, role),
    };
    this.runtimeControls.set(name, control);

    control.running = Promise.resolve()
      .then(() => runner(control))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.markError(name, message);
        // P1：删除 task_failed 协议字段（eventType/taskId/threadId），仅给 lead 邮箱
        // 写入人类可读的失败通知。任务级失败状态依然通过 task manager 体现。
        // void：runner 失败本身已由 markError 记录，这里 send 失败也只是丢条通知，不阻断。
        void this.messageBus.send({
          from: name,
          to: this.leadName,
          content: `Teammate ${name} failed: ${message}`,
        });
      })
      .finally(() => {
        control.running = undefined;
        control.waiters.clear();
        const currentMember = this.getMember(name);
        if (currentMember && currentMember.status !== "error") {
          this.markStopped(name);
        }
      });

    return { started: true, control };
  }

  wake(name: string): void {
    const control = this.runtimeControls.get(name);
    if (!control) {
      return;
    }

    const waiters = [...control.waiters];
    control.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  async waitForWake(control: TeammateRuntimeControl): Promise<void> {
    // 进入等待前先看一眼未读数：若有未读消息则不应该睡，立刻返回让上层 drain。
    if (control.stopRequested || (await this.messageBus.unreadCount(control.name)) > 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      control.waiters.add(resolve);
    });
  }

  requestStop(name: string): boolean {
    const control = this.runtimeControls.get(name);
    if (!control) {
      this.markStopped(name);
      return false;
    }

    control.stopRequested = true;
    this.wake(name);
    return true;
  }

  shouldStop(control: TeammateRuntimeControl): boolean {
    return control.stopRequested;
  }

  // P1：异步化。inboxSize 同步 API 已废弃，改为 await unreadCount。
  // 用 Promise.all 并发查询所有成员未读数，避免 N 次串行 fs 读放大延迟。
  async formatTeamStatus(): Promise<string> {
    const members = this.listMembers();
    if (members.length === 0) {
      return `team_dir ${this.teamDir}\n(no teammates)`;
    }

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
}
