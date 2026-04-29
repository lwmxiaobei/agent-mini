import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TOKEN_THRESHOLD, autoCompact, autoCompactResponseHistory } from "../src/compact.js";
import type { ChatMessage, ResponseInputItem } from "../src/types.js";

type FakeOpenAIClient = {
  chat: {
    completions: {
      create(args: { messages: Array<{ role: string; content: string }> }): Promise<{
        choices: Array<{ message: { content: string } }>;
      }>;
    };
  };
};

/**
 * 在临时目录里执行 compact 测试，避免把测试 transcript 写进真实项目目录。
 *
 * 为什么要包一层 helper：
 * - compact 会把完整历史落到 `.transcripts/`，如果直接在仓库根目录跑测试，会污染工作区。
 * - 使用临时 cwd 可以让每个测试拿到独立 transcript 目录，断言也更稳定。
 * - 把 cwd 切换和恢复封装起来，可以避免每个测试都重复写样板代码。
 */
async function withTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-agent-compact-"));
  process.chdir(tempDir);
  try {
    return await fn(tempDir);
  } finally {
    process.chdir(previous);
  }
}

/**
 * 创建一个只实现 compact 所需最小接口的 OpenAI client stub。
 *
 * 为什么不直接构造真实 SDK client：
 * - compact 测试只关心“传给总结模型的内容”和“返回 summary 后如何重建历史”，不需要网络。
 * - 最小 stub 可以精确捕获 prompt 内容，验证我们现在只总结旧前缀，而不是把最近消息也丢进摘要。
 * - 这样测试运行更快，也不会依赖外部凭据或真实模型行为。
 */
function createFakeClient(onCreate: (content: string) => void, summary = "summary from model"): FakeOpenAIClient {
  return {
    chat: {
      completions: {
        async create(args) {
          onCreate(args.messages[0]?.content ?? "");
          return {
            choices: [{ message: { content: summary } }],
          };
        },
      },
    },
  };
}

test("TOKEN_THRESHOLD uses the documented 50k limit", () => {
  assert.equal(TOKEN_THRESHOLD, 50000);
});

test("autoCompact summarizes only the older prefix and preserves recent chat messages verbatim", async () => {
  await withTempCwd(async () => {
    const chatHistory: ChatMessage[] = [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "middle request" },
      { role: "assistant", content: "middle reply" },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent reply" },
      { role: "tool", tool_call_id: "tool-1", content: "recent tool output" },
      { role: "user", content: "latest request" },
    ];

    let capturedPrompt = "";
    const client = createFakeClient((content) => {
      capturedPrompt = content;
    });

    const compacted = await autoCompact(client as any, "gpt-test", chatHistory);

    assert.match(capturedPrompt, /old request/);
    assert.match(capturedPrompt, /old reply/);
    assert.match(capturedPrompt, /middle request/);
    assert.doesNotMatch(capturedPrompt, /recent request/);
    assert.equal(String(compacted.messages[0]?.role), "user");
    assert.match(String(compacted.messages[0]?.content ?? ""), /\[Compressed conversation history\]/);
    assert.equal(String(compacted.messages[1]?.role), "assistant");
    assert.deepEqual(compacted.messages.slice(2), chatHistory.slice(4));
    assert.ok(fs.existsSync(compacted.transcriptPath));
  });
});

test("autoCompactResponseHistory keeps recent replay items and returns a continuity message", async () => {
  await withTempCwd(async () => {
    const responseHistory: ResponseInputItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "old request" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "old reply" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "middle request" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "middle reply" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "recent request" }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: "{\"path\":\"src/index.ts\"}",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "file contents",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "latest request" }],
      },
    ];

    let capturedPrompt = "";
    const client = createFakeClient((content) => {
      capturedPrompt = content;
    }, "responses summary");

    const compacted = await autoCompactResponseHistory(client as any, "gpt-test", responseHistory);

    assert.match(capturedPrompt, /old request/);
    assert.match(capturedPrompt, /middle request/);
    assert.doesNotMatch(capturedPrompt, /recent request/);
    assert.equal(String(compacted.messages[0]?.type), "message");
    assert.equal(String(compacted.messages[0]?.role), "user");
    assert.deepEqual(compacted.messages.slice(1), responseHistory.slice(4));
    assert.match(compacted.continuationMessage, /responses summary/);
    assert.match(compacted.continuationMessage, /Full transcript saved at:/);
    assert.ok(fs.existsSync(compacted.transcriptPath));
  });
});
