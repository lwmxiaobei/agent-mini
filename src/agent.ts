import OpenAI, { APIUserAbortError } from "openai";

import {
  microCompact,
  estimateTokens,
  autoCompact,
  autoCompactResponseHistory,
  TOKEN_THRESHOLD,
} from "./compact.js";
import { getDynamicMcpToolSurface } from "./mcp/runtime.js";
import { messageBus, teammateManager, LEAD_NAME, TOOLS, CHAT_TOOLS, BASE_TOOLS, BASE_CHAT_TOOLS, TEAMMATE_TOOLS, TEAMMATE_CHAT_TOOLS, BASE_TOOL_HANDLERS, taskManager } from "./tools.js";
import { renderInboxPrompt } from "./message-bus.js";
import { getSubagentDefinition, type SubagentDefinition } from "./subagents.js";
import type { TeammateRuntimeControl } from "./teammate-manager.js";
import type { ToolArgs, ResponseInputItem, ChatMessage, AgentState, UiBridge, TokenUsage } from "./types.js";

const NAG_THRESHOLD = 3;
const NAG_MESSAGE = "<reminder>Update your tasks with task_list or task_update.</reminder>";
const RESPONSES_COMPACT_INTERVAL = 20;

type ToolHandler = (args: ToolArgs, control?: RunControl) => Promise<string> | string;
type ToolHandlerMap = Record<string, ToolHandler>;
type RunControl = {
  signal?: AbortSignal;
};
type PreparedToolRuntime = {
  handlers: ToolHandlerMap;
  responseTools: readonly any[];
  chatTools: readonly any[];
};

export class TurnInterruptedError extends Error {
  responseId?: string;
  partialAssistantText?: string;

  constructor(options?: { responseId?: string; partialAssistantText?: string }) {
    super("Turn interrupted by user.");
    this.name = "TurnInterruptedError";
    this.responseId = options?.responseId;
    this.partialAssistantText = options?.partialAssistantText;
  }
}

export function isTurnInterruptedError(error: unknown): error is TurnInterruptedError {
  return error instanceof TurnInterruptedError;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TurnInterruptedError();
  }
}

function safeJsonParse(value: string): ToolArgs {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 为一个 assistant content part 生成稳定 key。
 *
 * 为什么要单独建 key：
 * - Responses 流里同一段文本可能先经历 `content_part.added`，再经历
 *   `output_text.delta`，最后再来 `output_text.done`。
 * - 如果不按 output/content 位置追踪已渲染长度，UI 很容易把同一段文本显示
 *   三遍，尤其是在不同后端混合发送这些事件的时候。
 * - 这里使用 output/content 下标组合，足以在单次响应内唯一标识一个文本块。
 */
function getResponseContentKey(outputIndex: unknown, contentIndex: unknown): string {
  return `${String(outputIndex ?? "")}:${String(contentIndex ?? "")}`;
}

/**
 * Normalize Responses API input into the explicit list form expected by the
 * ChatGPT Codex backend.
 *
 * Why this exists:
 * - The public OpenAI Responses API accepts a plain string as shorthand input,
 *   but `chatgpt.com/backend-api/codex/responses` rejects that shortcut and
 *   requires `input` to be a list.
 * - Converting strings into a single user message preserves the original
 *   behavior while making the request shape compatible with both backends.
 * - Existing array inputs are forwarded unchanged so tool-call follow-up items
 *   and previous structured payloads keep their original form.
 */
function normalizeResponseInput(inputItems: ResponseInputItem[] | string): ResponseInputItem[] {
  if (Array.isArray(inputItems)) {
    return inputItems;
  }

  return [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: inputItems,
        },
      ],
    },
  ];
}

/**
 * Build a canonical user-message item for stateless Responses replay.
 *
 * Why this exists:
 * - When `previous_response_id` is unavailable we must resend prior turns as an
 *   explicit input list, so user prompts need one stable shape.
 * - Keeping the constructor in one place avoids subtle inconsistencies between
 *   the first request of a turn and follow-up replay requests after tool calls.
 * - The same shape remains valid for providers that still support the public
 *   Responses API shorthand.
 */
function buildUserResponseMessage(text: string): ResponseInputItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text,
      },
    ],
  };
}

/**
 * 在 Responses 模式切链后的首轮请求里，把 compact 摘要显式拼回用户输入。
 *
 * 为什么需要这一步：
 * - 支持 `previous_response_id` 的 provider 平时把上下文保存在服务端，不会自动重放本地 `responseHistory`。
 * - 一旦 compact 时主动断开旧链，如果下一轮只发送新的用户问题，模型就会失去 compact 前的连续性。
 * - 这里把 compact 摘要和当前用户请求合并成一条 user message，可以在不改请求协议的前提下恢复上下文。
 */
function buildCompactedResponsesQuery(summary: string, query: string): string {
  return `${summary}\n\nCurrent user request:\n${query}`;
}

/**
 * Deep-clone replay items before reusing them in a later request.
 *
 * Why this exists:
 * - Response output objects come from the SDK and may be mutated elsewhere
 *   during rendering or debugging.
 * - Stateless replay should preserve the exact model-visible payload from the
 *   earlier round, not a shared object that another call could modify.
 * - JSON cloning is sufficient here because Responses items are plain data.
 */
function cloneResponseReplayItem<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Keep only the output items that are valid and useful for stateless replay.
 *
 * Why this exists:
 * - The ChatGPT Codex backend rejects `previous_response_id`, so later rounds
 *   must be rebuilt from prior assistant messages and function calls.
 * - Message and function-call items are enough to reconstruct the model-visible
 *   assistant state; ephemeral bookkeeping items do not help and may be invalid
 *   when sent back as input.
 * - Returning cloned objects lets callers append the items directly into
 *   `responseHistory` without worrying about shared references.
 */
function collectReplayableResponseOutput(output: unknown): ResponseInputItem[] {
  if (!Array.isArray(output)) {
    return [];
  }

  return output
    .filter((item): item is ResponseInputItem => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const type = String((item as { type?: unknown }).type ?? "");
      return type === "message" || type === "function_call";
    })
    .map((item) => cloneResponseReplayItem(item));
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && "text" in item) {
        return String((item as { text?: string }).text ?? "");
      }
      return "";
    })
    .join("");
}

/**
 * 从 Responses API 的 `output` 里提取 assistant 文本。
 *
 * 为什么要单独做这一步：
 * - UI 实时渲染主要依赖 `response.output_text.delta`，但不同后端并不保证
 *   一定会把最终文本完整地以 delta 形式流出来。
 * - 某些响应会在 `finalResponse().output` 里携带完整 message 文本，同时还带
 *   function_call；如果这里只信任流式 delta，UI 就会出现“只看到工具，没有
 *   看到模型文字”的问题。
 * - 这里统一从最终 `output` 兜底提取，确保无论流事件是否完整，assistant
 *   文本都能被恢复。
 */
export function extractAssistantTextFromResponseOutput(output: unknown): string {
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .map((item: any) => {
      if (item?.type === "message" && item?.role === "assistant") {
        return extractAssistantText(item.content);
      }
      if (item?.type === "text") {
        return extractAssistantText(item.text);
      }
      return "";
    })
    .join("")
    .trim();
}

/**
 * 计算最终响应里还没有被 UI 显示出来的 assistant 文本增量。
 *
 * 为什么不是直接再次整段 push：
 * - 如果前半段文本已经通过 delta 渲染出来，直接整段补发会导致重复显示。
 * - 最常见的缺口是“完全没流出来”或“只缺最后一小段”，因此优先走前缀补齐，
 *   让 UI 尽量保持一条连续 assistant 消息。
 * - 如果最终文本和已流出的前缀完全对不上，说明后端事件形态和预期差异更大，
 *   这时返回整段完整文本，至少保证用户能看到模型真实回答。
 */
export function getMissingAssistantText(streamedText: string, finalText: string): string {
  const streamed = streamedText.trim();
  const finalized = finalText.trim();

  if (!finalized) {
    return "";
  }
  if (!streamed) {
    return finalized;
  }
  if (finalized === streamed) {
    return "";
  }
  if (finalized.startsWith(streamed)) {
    return finalized.slice(streamed.length);
  }
  return finalized;
}

function repairInterruptedToolCallHistory(history: ChatMessage[]): void {
  if (history.length === 0) {
    return;
  }

  let assistantIndex = history.length - 1;
  while (assistantIndex >= 0 && history[assistantIndex]?.role === "tool") {
    assistantIndex -= 1;
  }

  if (assistantIndex < 0) {
    return;
  }

  const assistantMessage = history[assistantIndex];
  if (assistantMessage?.role !== "assistant" || !Array.isArray(assistantMessage.tool_calls) || assistantMessage.tool_calls.length === 0) {
    return;
  }

  const trailingMessages = history.slice(assistantIndex + 1);
  if (!trailingMessages.every((message) => message.role === "tool")) {
    return;
  }

  const expectedToolCallIds = assistantMessage.tool_calls
    .map((toolCall: any) => String(toolCall?.id ?? ""))
    .filter(Boolean);
  if (expectedToolCallIds.length === 0) {
    return;
  }

  const actualToolCallIds = new Set(
    trailingMessages.map((message) => String(message.tool_call_id ?? "")).filter(Boolean),
  );
  const hasAllToolResponses = expectedToolCallIds.every((toolCallId) => actualToolCallIds.has(toolCallId));
  if (hasAllToolResponses) {
    return;
  }

  const assistantText = String(assistantMessage.content ?? "");
  history.splice(assistantIndex);
  if (assistantText.trim()) {
    history.push({
      role: "assistant",
      content: assistantText,
    });
  }
}

function createSilentBridge(): UiBridge {
  return {
    appendAssistantDelta() {},
    appendThinkingDelta() {},
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool() {},
    updateUsage() {},
  };
}

function normalizeTeammateName(value: unknown): string {
  return String(value ?? "").trim();
}

function isValidTeammateName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeMessageType(value: unknown): "message" | "broadcast" {
  return value === "broadcast" ? "broadcast" : "message";
}

function buildTeammateSystem(baseSystem: string, name: string, role: string): string {
  return `${baseSystem}
You are teammate "${name}" in a persistent agent team.
Your role: ${role}.
You do not speak directly to the human user.
You receive work through inbox messages injected as user messages.
Use message_send to coordinate with lead or other teammates.
When you complete a meaningful chunk, send a concise update to lead.`;
}

function buildInboxWorkPrompt(): string {
  return "Process the inbox items in order. Use available tools to do the work. Coordinate via message_send when needed.";
}

// 子代理需要按定义裁剪工具，而不是总是继承整套 BASE_TOOLS。
// 这样 `task` 才能从“再跑一次 loop”升级成“按角色运行的 worker”，
// 这是 Claude Code 子代理体系里最核心、也是最值得最小化迁移的部分。
function selectToolsByName(tools: readonly any[], allowedToolNames: readonly string[]): any[] {
  const allowed = new Set(allowedToolNames);
  return tools.filter((tool) => allowed.has(String(tool?.name ?? "")));
}

// `explore` 这类只读 agent 不能直接复用通用 bash handler，
// 因为通用 handler 允许执行任意工作区命令。这里做一层显式白名单，
// 目的是把“只读”从 prompt 约束升级为运行时约束，避免模型失手写文件。
function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  const forbiddenPatterns = [
    /(^|[\s;&|])(rm|mv|cp|mkdir|touch|chmod|chown)\b/,
    /(^|[\s;&|])(git\s+(add|commit|checkout|switch|restore|reset|clean|merge|rebase|pull|push))\b/,
    /(^|[\s;&|])(npm|pnpm|yarn|bun|pip|pip3)\s+(install|add|remove|uninstall)\b/,
    />/,
    /\|/,
  ];

  return !forbiddenPatterns.some((pattern) => pattern.test(trimmed));
}

// 这里把“工具列表”和“工具执行函数”一起裁剪。
// 只裁工具定义不裁 handler 会留下越权入口，只裁 handler 不裁 schema 又会误导模型。
function buildSubagentRuntime(definition: SubagentDefinition): PreparedToolRuntime {
  const responseTools = selectToolsByName(BASE_TOOLS, definition.allowedTools);
  const chatTools = selectToolsByName(BASE_CHAT_TOOLS, definition.allowedTools);
  const handlers: ToolHandlerMap = { ...BASE_TOOL_HANDLERS };

  if (definition.readOnlyShell) {
    handlers.bash = ({ command }) => {
      const normalized = String(command ?? "");
      if (!isReadOnlyShellCommand(normalized)) {
        return "Error: This sub-agent is read-only. Only non-mutating shell commands are allowed.";
      }
      return BASE_TOOL_HANDLERS.bash({ command: normalized });
    };
  }

  for (const toolName of Object.keys(handlers)) {
    if (!definition.allowedTools.includes(toolName)) {
      delete handlers[toolName];
    }
  }

  return {
    handlers,
    responseTools,
    chatTools,
  };
}

async function prepareToolRuntime(
  baseHandlers: ToolHandlerMap,
  baseResponseTools: readonly any[],
  baseChatTools: readonly any[],
): Promise<PreparedToolRuntime> {
  const dynamicMcp = await getDynamicMcpToolSurface();
  return {
    handlers: {
      ...baseHandlers,
      ...dynamicMcp.handlers,
    },
    responseTools: [
      ...baseResponseTools,
      ...dynamicMcp.responseTools,
    ],
    chatTools: [
      ...baseChatTools,
      ...dynamicMcp.chatTools,
    ],
  };
}

function calculateCost(inputTokens: number, outputTokens: number, cachedInputTokens: number): number {
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  return (uncachedInput * 2.0 + cachedInputTokens * 0.5 + outputTokens * 8.0) / 1_000_000;
}

function extractTokenUsage(usage: any): TokenUsage {
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const cachedInputTokens = Number(
    usage?.input_token_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const cost = calculateCost(inputTokens, outputTokens, cachedInputTokens);
  return { inputTokens, outputTokens, cachedInputTokens, cost };
}

async function streamResponse(
  client: OpenAI,
  model: string,
  system: string,
  showThinking: boolean,
  inputItems: ResponseInputItem[] | string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
  tools: readonly any[] = TOOLS,
  control?: RunControl,
  onUsage?: (usage: TokenUsage) => void,
): Promise<any> {
  throwIfAborted(control?.signal);
  const normalizedInstructions = system.trim() || "You are a helpful coding assistant.";
  const normalizedInput = normalizeResponseInput(inputItems);

  const stream = client.responses.stream({
    model,
    instructions: normalizedInstructions,
    input: normalizedInput as any,
    // ChatGPT Codex backend is stricter than the public Responses API.
    // `sub2api`'s working probe payload explicitly sends `store: false` for the
    // Codex OAuth path, and the public API also accepts this field, so we set
    // it unconditionally to keep one compatible request shape for both backends.
    store: false,
    previous_response_id: previousResponseId,
    tools: tools as any,
  }, control?.signal ? { signal: control.signal } : undefined);

  let responseId: string | undefined;
  let assistantText = "";
  const streamedFunctionCalls = new Map<string, any>();
  const streamedAssistantContent = new Map<string, string>();

  /**
   * ChatGPT Codex stream responses are slightly different from the public
   * Responses API as surfaced through the OpenAI SDK:
   * - tool-call items are emitted over SSE events,
   * - but `stream.finalResponse()` can still return `output: []`.
   * We therefore key partial function calls by `output_index` and rebuild the
   * final tool-call list from the stream itself when needed.
   */
  const getFunctionCallKey = (event: any, fallbackIndex?: number): string => {
    if (event?.output_index !== undefined) {
      return String(event.output_index);
    }
    if (event?.item?.call_id) {
      return String(event.item.call_id);
    }
    if (event?.item?.id) {
      return String(event.item.id);
    }
    return String(fallbackIndex ?? streamedFunctionCalls.size);
  };

  try {
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === "response.created") {
        responseId = String(event.response?.id ?? responseId ?? "");
      }

      if (event.type === "response.output_text.delta") {
        const delta = String(event.delta ?? "");
        assistantText += delta;
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        streamedAssistantContent.set(
          contentKey,
          `${streamedAssistantContent.get(contentKey) ?? ""}${delta}`,
        );
        bridge.appendAssistantDelta(delta);
        continue;
      }

      /**
       * 有些 Responses 后端不会先发 `output_text.delta`，而是直接先把一个完整或
       * 半完整的 output_text part 塞进 `content_part.added/done`。如果不消费这些
       * 事件，UI 就会出现“只有工具调用，没有 assistant 文本”。
       */
      if (event.type === "response.content_part.added" && event.part?.type === "output_text") {
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        const nextText = String(event.part?.text ?? "");
        const emittedText = streamedAssistantContent.get(contentKey) ?? "";
        const missingText = nextText.startsWith(emittedText) ? nextText.slice(emittedText.length) : nextText;

        if (missingText) {
          assistantText += missingText;
          bridge.appendAssistantDelta(missingText);
        }
        streamedAssistantContent.set(contentKey, nextText);
        continue;
      }

      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        const key = getFunctionCallKey(event);
        streamedFunctionCalls.set(key, {
          ...cloneResponseReplayItem(event.item),
          arguments: String(event.item?.arguments ?? ""),
        });
        bridge.finalizeStreaming();
        continue;
      }

      if (event.type === "response.function_call_arguments.delta") {
        const key = getFunctionCallKey(event);
        const current = streamedFunctionCalls.get(key);
        if (current) {
          current.arguments = `${String(current.arguments ?? "")}${String(event.delta ?? "")}`;
          streamedFunctionCalls.set(key, current);
        }
        continue;
      }

      if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        const key = getFunctionCallKey(event);
        const current = streamedFunctionCalls.get(key) ?? {};
        streamedFunctionCalls.set(key, {
          ...current,
          ...cloneResponseReplayItem(event.item),
          arguments: String(event.item?.arguments ?? current.arguments ?? ""),
        });
        continue;
      }

      if (event.type === "response.content_part.done" && event.part?.type === "output_text") {
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        const nextText = String(event.part?.text ?? "");
        const emittedText = streamedAssistantContent.get(contentKey) ?? "";
        const missingText = nextText.startsWith(emittedText) ? nextText.slice(emittedText.length) : nextText;

        if (missingText) {
          assistantText += missingText;
          bridge.appendAssistantDelta(missingText);
        }
        streamedAssistantContent.set(contentKey, nextText);
        continue;
      }

      if (event.type === "response.output_text.done") {
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        const nextText = String(event.text ?? "");
        const emittedText = streamedAssistantContent.get(contentKey) ?? "";
        const missingText = nextText.startsWith(emittedText) ? nextText.slice(emittedText.length) : nextText;

        if (missingText) {
          assistantText += missingText;
          bridge.appendAssistantDelta(missingText);
        }
        streamedAssistantContent.set(contentKey, nextText);
        continue;
      }

      if (showThinking && ["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type)) {
        bridge.appendThinkingDelta(String(event.delta ?? ""));
        continue;
      }
    }

    const response = await stream.finalResponse();
    if (response.usage) {
      onUsage?.(extractTokenUsage(response.usage));
    }
    const sdkOutput = Array.isArray(response.output) ? response.output : [];
    const recoveredAssistantText = extractAssistantTextFromResponseOutput(sdkOutput);
    const missingAssistantText = getMissingAssistantText(assistantText, recoveredAssistantText);

    /**
     * 这里必须在 finalize 之前补 UI：
     * - `appendAssistantDelta()` 依赖当前正在流式渲染的 message id；
     * - 一旦先 finalize，就只能新建一条 assistant 消息，文本会和前面的片段断开；
     * - 先补齐缺失尾巴，再 finalize，才能最大程度保留“同一条回答”的连续性。
     */
    if (missingAssistantText) {
      bridge.appendAssistantDelta(missingAssistantText);
      assistantText = `${assistantText}${missingAssistantText}`;
    }
    bridge.finalizeStreaming();

    /**
     * Preserve SDK output when present, but patch in a synthetic fallback for
     * Codex OAuth streams whose final response omits the items we already saw on
     * the wire.
     */
    if (sdkOutput.length > 0) {
      return response;
    }

    const rebuiltOutput: any[] = [];
    if (assistantText) {
      rebuiltOutput.push({
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: assistantText,
          },
        ],
      });
    }

    for (const item of streamedFunctionCalls.values()) {
      rebuiltOutput.push(item);
    }

    return {
      ...response,
      output: rebuiltOutput,
    };
  } catch (error) {
    bridge.finalizeStreaming();
    if (error instanceof APIUserAbortError || control?.signal?.aborted) {
      throw new TurnInterruptedError({
        responseId,
        partialAssistantText: assistantText || undefined,
      });
    }
    throw error;
  }
}

async function streamChatCompletion(
  client: OpenAI,
  model: string,
  system: string,
  history: ChatMessage[],
  bridge: UiBridge,
  tools: readonly any[] = CHAT_TOOLS,
  showThinking: boolean = false,
  control?: RunControl,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ content: string | null; tool_calls: any[]; reasoning_content?: string }> {
  throwIfAborted(control?.signal);

  const createParams: any = {
    model,
    messages: [{ role: "system", content: system }, ...history] as any,
    tools: tools as any,
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
  };
  if (showThinking) {
    createParams.thinking = { type: "enabled" };
  }
  const stream = await client.chat.completions.create(
    createParams as any,
    control?.signal ? { signal: control.signal } : undefined,
  ) as any;

  let content = "";
  let reasoningContent = "";
  const toolCallBuffers: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};

  try {
    for await (const chunk of stream) {
      if (chunk.usage) {
        onUsage?.(extractTokenUsage(chunk.usage));
      }
      const delta = chunk.choices?.[0]?.delta as any;
      if (!delta) continue;

      if (showThinking && delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        bridge.appendThinkingDelta(delta.reasoning_content);
      }

      if (delta.content) {
        content += delta.content;
        bridge.appendAssistantDelta(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallBuffers[tc.index]) {
            toolCallBuffers[tc.index] = {
              id: tc.id ?? "",
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
          }
          const buf = toolCallBuffers[tc.index];
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.function.name += tc.function.name;
          if (tc.function?.arguments) buf.function.arguments += tc.function.arguments;
        }
      }
    }

    bridge.finalizeStreaming();

    const toolCalls = Object.keys(toolCallBuffers)
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => toolCallBuffers[Number(key)]);

    return {
      content: content || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : [],
      reasoning_content: reasoningContent || undefined,
    };
  } catch (error) {
    bridge.finalizeStreaming();
    if (error instanceof APIUserAbortError || control?.signal?.aborted) {
      throw new TurnInterruptedError({
        partialAssistantText: content || undefined,
      });
    }
    throw error;
  }
}

async function runToolCall(
  toolCall: any,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  control?: RunControl,
): Promise<ResponseInputItem> {
  const name = String(toolCall.name ?? toolCall.function?.name ?? "unknown_tool");
  const rawArgs = String(toolCall.arguments ?? toolCall.function?.arguments ?? "{}");
  const args = safeJsonParse(rawArgs);

  const handler = handlers[name];
  const outputText = handler ? await handler(args, control) : `Unknown tool: ${name}`;
  bridge.pushTool(name, args, outputText);

  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: outputText,
  };
}

async function sendTeamMessage(from: string, to: string, content: string, type: "message" | "broadcast"): Promise<string> {
  const recipient = to.trim();
  const body = content.trim();
  if (!recipient) {
    return "Error: Missing recipient.";
  }
  if (!body) {
    return "Error: Missing content.";
  }

  let recipients: string[];
  if (type === "broadcast" && recipient === "all") {
    recipients = [LEAD_NAME, ...teammateManager.listMembers().map((member) => member.name)]
      .filter((name, index, all) => name !== from && all.indexOf(name) === index);
  } else {
    recipients = [recipient];
  }

  if (recipients.length === 0) {
    return "Error: No recipients available.";
  }

  for (const name of recipients) {
    if (name === LEAD_NAME) {
      continue;
    }

    const member = teammateManager.getMember(name);
    if (!member) {
      return `Error: Unknown teammate: ${name}`;
    }
    if (!teammateManager.isRunning(name)) {
      return `Error: Teammate ${name} is not running. Spawn or restart it first.`;
    }
  }

  for (const name of recipients) {
    messageBus.send({
      from,
      to: name,
      content: body,
      type: type === "broadcast" ? "broadcast" : "message",
    });
    if (name !== LEAD_NAME) {
      teammateManager.wake(name);
    }
  }

  return `Sent ${type} to ${recipients.join(", ")}`;
}

function buildSharedTeamHandlers(agentName: string): Pick<ToolHandlerMap, "message_send"> {
  return {
    message_send: async ({ to, content, type }) => sendTeamMessage(
      agentName,
      String(to ?? ""),
      String(content ?? ""),
      normalizeMessageType(type),
    ),
  };
}

async function launchTeammateRuntime(config: AgentConfig, control: TeammateRuntimeControl): Promise<void> {
  const bridge = createSilentBridge();

  while (true) {
    if (!teammateManager.shouldStop(control) && messageBus.inboxSize(control.name) === 0) {
      teammateManager.markIdle(control.name);
      await teammateManager.waitForWake(control);
    }

    const inbox = messageBus.drainInbox(control.name);
    const shutdownRequested = inbox.some((message) => message.type === "shutdown_request");
    const actionableMessages = inbox.filter((message) => message.type !== "shutdown_request");

    if (actionableMessages.length > 0) {
      teammateManager.markWorking(control.name);
      const prompt = `${renderInboxPrompt(actionableMessages)}\n\n${buildInboxWorkPrompt()}`;
      const runtime = await prepareToolRuntime(
        buildTeammateHandlers(control.name),
        TEAMMATE_TOOLS,
        TEAMMATE_CHAT_TOOLS,
      );
      await runTurn(
        config,
        prompt,
        control.state,
        bridge,
        runtime.handlers,
        runtime.responseTools,
        runtime.chatTools,
      );
    }

    if (shutdownRequested || teammateManager.shouldStop(control)) {
      messageBus.send({
        from: control.name,
        to: LEAD_NAME,
        type: "shutdown_response",
        content: `Teammate ${control.name} has shut down.`,
      });
      teammateManager.markStopped(control.name);
      return;
    }
  }
}

function buildLeadHandlers(config: AgentConfig, bridge: UiBridge): ToolHandlerMap {
  return {
    ...BASE_TOOL_HANDLERS,
    ...buildSharedTeamHandlers(LEAD_NAME),
    task: async ({ description, subagent_type }) => {
      const taskDescription = String(description ?? "");
      const definition = getSubagentDefinition(typeof subagent_type === "string" ? subagent_type : undefined);
      const subSystem = `${config.system}\n${definition.systemPrompt}`;

      bridge.pushTool(
        "task",
        { description: taskDescription, subagent_type: definition.name },
        `launching ${definition.name} sub-agent...`,
      );

      let result: string;
      if (config.apiMode === "chat-completions") {
        result = await subAgentLoopChatCompletions(config.client, config.model, subSystem, taskDescription, bridge, definition);
      } else {
        result = await subAgentLoopResponses(config.client, config.model, subSystem, taskDescription, bridge, definition);
      }

      return result;
    },
    teammate_spawn: async ({ name, role, prompt }) => {
      const teammateName = normalizeTeammateName(name);
      const teammateRole = String(role ?? "").trim();
      const initialPrompt = String(prompt ?? "").trim();

      if (!teammateName || !teammateRole || !initialPrompt) {
        return "Error: name, role, and prompt are required.";
      }
      if (!isValidTeammateName(teammateName)) {
        return `Error: Invalid teammate name: ${teammateName}`;
      }
      if (teammateName === LEAD_NAME) {
        return `Error: ${LEAD_NAME} is reserved.`;
      }
      if (teammateManager.isRunning(teammateName)) {
        return `Error: Teammate ${teammateName} is already running. Use message_send to assign more work.`;
      }

      teammateManager.ensureMember(teammateName, teammateRole);

      const { started } = teammateManager.startRuntime(teammateName, teammateRole, async (control) => {
        const teammateConfig: AgentConfig = {
          ...config,
          system: buildTeammateSystem(config.system, teammateName, teammateRole),
        };
        await launchTeammateRuntime(teammateConfig, control);
      });

      if (!started) {
        return `Error: Teammate ${teammateName} is already running.`;
      }

      messageBus.send({
        from: LEAD_NAME,
        to: teammateName,
        type: "message",
        content: initialPrompt,
      });
      teammateManager.wake(teammateName);

      return `Spawned teammate ${teammateName} (${teammateRole}). Initial prompt delivered.`;
    },
    teammate_shutdown: ({ name }) => {
      const requestedName = String(name ?? "").trim();
      const targets = requestedName
        ? [requestedName]
        : teammateManager.listMembers().map((member) => member.name);

      if (targets.length === 0) {
        return "(no teammates)";
      }

      return targets
        .map((teammateName) => {
          const member = teammateManager.getMember(teammateName);
          if (!member) {
            return `- ${teammateName}: not found`;
          }

          if (!teammateManager.isRunning(teammateName)) {
            teammateManager.markStopped(teammateName);
            return `- ${teammateName}: already stopped`;
          }

          messageBus.send({
            from: LEAD_NAME,
            to: teammateName,
            type: "shutdown_request",
            content: "Graceful shutdown requested by lead.",
          });
          teammateManager.requestStop(teammateName);
          teammateManager.wake(teammateName);
          return `- ${teammateName}: shutdown requested`;
        })
        .join("\n");
    },
  };
}

function buildTeammateHandlers(agentName: string): ToolHandlerMap {
  return {
    ...BASE_TOOL_HANDLERS,
    ...buildSharedTeamHandlers(agentName),
  };
}

async function subAgentLoopResponses(
  client: OpenAI,
  model: string,
  system: string,
  description: string,
  bridge: UiBridge,
  definition: SubagentDefinition,
): Promise<string> {
  const runtime = buildSubagentRuntime(definition);
  let nextInput: ResponseInputItem[] | string = [
    { role: "user", content: [{ type: "input_text", text: description }] },
  ];
  let currentResponseId: string | undefined;
  let lastText = "";

  for (let round = 0; round < definition.maxRounds; round += 1) {
    const response = await streamResponse(client, model, system, false, nextInput, currentResponseId, bridge, runtime.responseTools);
    currentResponseId = response.id;

    const textItems = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "message" || item.type === "text")
      : [];
    for (const item of textItems) {
      const text = extractAssistantText(item.content ?? item.text ?? "");
      if (text.trim()) lastText = text.trim();
    }

    const outputText = Array.isArray(response.output)
      ? response.output
          .map((item: any) => {
            if (item.type === "message") return extractAssistantText(item.content);
            return "";
          })
          .join("")
          .trim()
      : "";
    if (outputText) lastText = outputText;

    const toolCalls = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "function_call")
      : [];

    if (toolCalls.length === 0) break;

    const results: ResponseInputItem[] = [];
    for (const toolCall of toolCalls) {
      results.push(await runToolCall(toolCall, bridge, runtime.handlers));
    }
    nextInput = results;
  }

  return lastText || "(sub-agent completed with no text output)";
}

async function subAgentLoopChatCompletions(
  client: OpenAI,
  model: string,
  system: string,
  description: string,
  bridge: UiBridge,
  definition: SubagentDefinition,
): Promise<string> {
  const runtime = buildSubagentRuntime(definition);
  const history: ChatMessage[] = [{ role: "user", content: description }];
  let lastText = "";

  for (let round = 0; round < definition.maxRounds; round += 1) {
    const message = await streamChatCompletion(client, model, system, history, bridge, runtime.chatTools, false);

    const assistantText = extractAssistantText(message.content);
    if (assistantText.trim()) {
      lastText = assistantText.trim();
    }

    history.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls.length > 0 ? message.tool_calls : undefined,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });

    const toolCalls = message.tool_calls;
    if (toolCalls.length === 0) break;

    for (const toolCall of toolCalls) {
      const name = String(toolCall.function?.name ?? "unknown_tool");
      const args = safeJsonParse(String(toolCall.function?.arguments ?? "{}"));
      const handler = runtime.handlers[name];
      const outputText = handler ? await handler(args) : `Unknown tool: ${name}`;
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });
    }
  }

  return lastText || "(sub-agent completed with no text output)";
}

async function agentLoop(
  config: AgentConfig,
  query: string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
  state: AgentState,
  handlers: ToolHandlerMap,
  tools: readonly any[] = TOOLS,
  control?: RunControl,
  onUsage?: (usage: TokenUsage) => void,
): Promise<string | undefined> {
  /**
   * Most Responses providers support `previous_response_id`, so they can keep
   * server-side state and only receive the latest delta. ChatGPT Codex OAuth
   * does not support that parameter, so in that one branch we replay the local
   * conversation transcript on every round instead.
   */
  const usesStatelessReplay = !config.supportsPreviousResponseId;
  /**
   * 无论 provider 是否支持 `previous_response_id`，本地都持续维护一份可重放历史。
   *
   * 为什么要在 stateful provider 上也这么做：
   * - responses 模式的 compact 需要本地历史做总结，否则只能定期把链路清空。
   * - `/resume`、状态栏估算、手动 `/compact` 也都依赖同一份本地上下文副本。
   * - 真正请求模型时，只有 stateless 分支会重放它，因此不会改变支持服务端链路的正常交互成本。
   */
  const replayHistory = [
    ...state.responseHistory.map((item) => cloneResponseReplayItem(item)),
    buildUserResponseMessage(query),
  ];
  let nextInput: ResponseInputItem[] | string = usesStatelessReplay
    ? replayHistory
    : [buildUserResponseMessage(query)];
  let currentResponseId = usesStatelessReplay ? undefined : previousResponseId;

  while (true) {
    throwIfAborted(control?.signal);

    const response = await streamResponse(
      config.client,
      config.model,
      config.system,
      config.showThinking,
      nextInput,
      currentResponseId,
      bridge,
      tools,
      control,
    );
    currentResponseId = response.id;

    replayHistory.push(...collectReplayableResponseOutput(response.output));

    const toolCalls = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "function_call")
      : [];

    if (toolCalls.length === 0) {
      state.responseHistory = replayHistory.map((item) => cloneResponseReplayItem(item));
      return currentResponseId;
    }

    const hasTaskCall = toolCalls.some((tc: any) => String(tc.name).startsWith("task_"));
    state.roundsSinceTask = hasTaskCall ? 0 : state.roundsSinceTask + 1;

    const results: ResponseInputItem[] = [];
    for (const toolCall of toolCalls) {
      throwIfAborted(control?.signal);
      results.push(await runToolCall(toolCall, bridge, handlers, control));
      throwIfAborted(control?.signal);
    }

    if (state.roundsSinceTask >= NAG_THRESHOLD && taskManager.hasActiveTasks()) {
      const lastResult = results[results.length - 1] as any;
      if (lastResult) {
        lastResult.output = `${NAG_MESSAGE}\n${lastResult.output}`;
      }
    }

    replayHistory.push(...results.map((item) => cloneResponseReplayItem(item)));

    if (usesStatelessReplay) {
      nextInput = replayHistory;
      currentResponseId = undefined;
    } else {
      nextInput = results;
    }
  }
}

async function agentLoopWithChatCompletions(
  config: AgentConfig,
  history: ChatMessage[],
  bridge: UiBridge,
  state: AgentState,
  handlers: ToolHandlerMap,
  tools: readonly any[] = CHAT_TOOLS,
  control?: RunControl,
  onUsage?: (usage: TokenUsage) => void,
): Promise<void> {
  while (true) {
    throwIfAborted(control?.signal);
    microCompact(history);

    if (estimateTokens(history) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      const compacted = await autoCompact(config.client, config.model, history);
      history.length = 0;
      history.push(...compacted.messages);
      state.compactCount += 1;
    }

    let message;
    try {
      message = await streamChatCompletion(
        config.client,
        config.model,
        config.system,
        history,
        bridge,
        tools,
        config.showThinking,
        control,
        onUsage,
      );
    } catch (error) {
      if (error instanceof TurnInterruptedError && error.partialAssistantText) {
        history.push({
          role: "assistant",
          content: error.partialAssistantText,
        });
      }
      throw error;
    }

    history.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls.length > 0 ? message.tool_calls : undefined,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });

    const toolCalls = message.tool_calls;
    if (toolCalls.length === 0) {
      return;
    }

    const hasTaskCall = toolCalls.some((tc: any) => String(tc.function?.name).startsWith("task_"));
    state.roundsSinceTask = hasTaskCall ? 0 : state.roundsSinceTask + 1;

    for (const toolCall of toolCalls) {
      throwIfAborted(control?.signal);
      const name = String(toolCall.function?.name ?? "unknown_tool");
      const args = safeJsonParse(String(toolCall.function?.arguments ?? "{}"));
      const handler = handlers[name];
      const outputText = handler ? await handler(args, control) : `Unknown tool: ${name}`;
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });

      throwIfAborted(control?.signal);
    }

    if (state.roundsSinceTask >= NAG_THRESHOLD && taskManager.hasActiveTasks()) {
      history.push({
        role: "user",
        content: NAG_MESSAGE,
      });
    }
  }
}

async function runTurn(
  config: AgentConfig,
  query: string,
  state: AgentState,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  responseTools: readonly any[],
  chatTools: readonly any[],
  control?: RunControl,
): Promise<void> {
  throwIfAborted(control?.signal);
  const { apiMode } = config;
  state.turnCount += 1;
  state.roundsSinceTask = 0;

  const turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 };
  const onUsage = (u: TokenUsage) => {
    turnUsage.inputTokens += u.inputTokens;
    turnUsage.outputTokens += u.outputTokens;
    turnUsage.cachedInputTokens += u.cachedInputTokens;
    turnUsage.cost += u.cost;
    bridge.updateUsage({ ...turnUsage });
  };

  if (apiMode === "chat-completions") {
    for (const msg of state.chatHistory) {
      if (msg.role === "assistant" && "reasoning_content" in msg) {
        delete msg.reasoning_content;
      }
    }

    microCompact(state.chatHistory);

    if (estimateTokens(state.chatHistory) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      const compacted = await autoCompact(config.client, config.model, state.chatHistory);
      state.chatHistory.length = 0;
      state.chatHistory.push(...compacted.messages);
      state.compactCount += 1;
    }

    state.chatHistory.push({ role: "user", content: query });
    try {
      await agentLoopWithChatCompletions(config, state.chatHistory, bridge, state, handlers, chatTools, control, onUsage);
    } catch (error) {
      if (error instanceof TurnInterruptedError) {
        repairInterruptedToolCallHistory(state.chatHistory);
      }
      throw error;
    }
    return;
  }

  if (state.turnCount > 1 && (state.turnCount - 1) % RESPONSES_COMPACT_INTERVAL === 0) {
    bridge.pushAssistant("Compacting Responses API context chain...");
    if (state.responseHistory.length > 0) {
      const compacted = await autoCompactResponseHistory(
        config.client,
        config.model,
        state.responseHistory,
      );
      state.responseHistory = compacted.messages;
      /**
       * 仅 stateful provider 需要额外保存待注入的 compact 摘要。
       *
       * 为什么 stateless replay 不需要：
       * - stateless 分支下一轮会直接发送 `state.responseHistory`，其中已经包含 compact summary。
       * - stateful 分支不会默认重放本地历史，所以切链后的第一轮必须显式把摘要带回请求里。
       */
      state.pendingCompactedContext = config.supportsPreviousResponseId
        ? compacted.continuationMessage
        : undefined;
    }
    state.previousResponseId = undefined;
    state.compactCount += 1;
  }

  const pendingCompactedContext = state.pendingCompactedContext;
  const responsesQuery = pendingCompactedContext
    ? buildCompactedResponsesQuery(pendingCompactedContext, query)
    : query;

  try {
    state.previousResponseId = await agentLoop(
      config,
      responsesQuery,
      state.previousResponseId,
      bridge,
      state,
      handlers,
      responseTools,
      control,
      onUsage,
    );
    state.pendingCompactedContext = undefined;
  } catch (error) {
    if (error instanceof TurnInterruptedError && error.responseId) {
      state.previousResponseId = error.responseId;
      state.pendingCompactedContext = undefined;
    }
    throw error;
  }
}

export type AgentConfig = {
  client: OpenAI;
  model: string;
  system: string;
  showThinking: boolean;
  apiMode: "responses" | "chat-completions";
  supportsPreviousResponseId: boolean;
};

export async function runAgentTurn(
  config: AgentConfig,
  query: string,
  state: AgentState,
  bridge: UiBridge,
  control?: RunControl,
): Promise<void> {
  const runtime = await prepareToolRuntime(buildLeadHandlers(config, bridge), TOOLS, CHAT_TOOLS);
  await runTurn(config, query, state, bridge, runtime.handlers, runtime.responseTools, runtime.chatTools, control);
}
