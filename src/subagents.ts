export type SubagentDefinition = {
  name: "general-purpose" | "explore";
  whenToUse: string;
  systemPrompt: string;
  allowedTools: readonly string[];
  maxRounds: number;
  readOnlyShell: boolean;
};

// 两个内置子代理：
export const SUBAGENT_DEFINITIONS: readonly SubagentDefinition[] = [
  {
    name: "general-purpose",
    whenToUse: "Default worker for implementation, editing, and focused subtasks inside the current workspace.",
    systemPrompt:
      "You are a general-purpose sub-agent handling a specific task. Complete it thoroughly, use tools directly, and end with a concise summary of what you changed or found.",
    allowedTools: [
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "task_create",
      "task_update",
      "task_list",
      "task_get",
      "list_mcp_resources",
      "read_mcp_resource",
      "mcp_call",
      "load_skill",
    ],
    maxRounds: 30,
    readOnlyShell: false,
  },
  {
    name: "explore",
    whenToUse: "Read-only codebase exploration, searching, tracing behavior, and answering implementation questions without changing files.",
    systemPrompt: `You are a read-only exploration sub-agent.
Your only job is to inspect the workspace, search code, read files, and report findings clearly.
You must not modify files.
You must not run shell commands that change files, install dependencies, create directories, or alter git state.
Prefer glob for file discovery, grep for content search, and read_file for targeted inspection. Use bash for read-only commands such as ls, find, cat, git status, and git diff.
Return findings as a concise factual summary.`,
    allowedTools: [
      "bash",
      "read_file",
      "glob",
      "grep",
      "task_list",
      "task_get",
      "list_mcp_resources",
      "read_mcp_resource",
      "mcp_call",
      "load_skill",
    ],
    maxRounds: 20,
    readOnlyShell: true,
  },
] as const;

// 这里提供统一入口，而不是让调用方自己遍历数组，
// 这样后续如果 agent 定义改成从文件或配置加载，调用方不需要改。
export function getSubagentDefinition(name?: string): SubagentDefinition {
  if (!name) {
    return SUBAGENT_DEFINITIONS[0];
  }

  return SUBAGENT_DEFINITIONS.find((agent) => agent.name === name) ?? SUBAGENT_DEFINITIONS[0];
}

// Task 工具描述里直接暴露可选 agent，有助于主 agent 在不额外读文档的情况下学会委派。
export function describeSubagentsForHumans(): string {
  return SUBAGENT_DEFINITIONS
    .map((agent) => `- ${agent.name}: ${agent.whenToUse}`)
    .join("\n");
}
