import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { BASE_TOOLS, BASE_TOOL_HANDLERS } from "../src/tools.js";

// 如果跑测试的机器上没有 ripgrep，这组用例没法跑，直接跳过。
function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("glob tool is registered in BASE_TOOLS and routed", () => {
  const names = BASE_TOOLS.map((t) => t.name);
  assert.ok(names.includes("glob"), "glob should be registered in BASE_TOOLS");
  assert.ok(typeof BASE_TOOL_HANDLERS.glob === "function", "glob handler should be wired");
});

test("grep tool is registered in BASE_TOOLS and routed", () => {
  const names = BASE_TOOLS.map((t) => t.name);
  assert.ok(names.includes("grep"), "grep should be registered in BASE_TOOLS");
  assert.ok(typeof BASE_TOOL_HANDLERS.grep === "function", "grep handler should be wired");
});

test("glob finds TypeScript source files", { skip: !hasRipgrep() }, async () => {
  // code-agent 仓库自己就是最方便的 fixture：至少有 src/*.ts。
  const result = await BASE_TOOL_HANDLERS.glob({ pattern: "src/**/*.ts" });
  assert.ok(typeof result === "string" ? result : await result, "should return a string result");
  const text = await result;
  assert.match(text, /src\//, "result should contain paths under src/");
  assert.match(text, /\.ts/, "result should include .ts files");
});

test("glob reports 'No files found' when nothing matches", { skip: !hasRipgrep() }, async () => {
  const text = await BASE_TOOL_HANDLERS.glob({ pattern: "**/__definitely_not_a_real_file__.xyz" });
  assert.equal(text, "No files found");
});

test("grep finds a known identifier in the source", { skip: !hasRipgrep() }, async () => {
  // BASE_TOOL_HANDLERS 本身就是 code-agent 里的标志性符号，必然能 grep 到。
  const text = await BASE_TOOL_HANDLERS.grep({
    pattern: "BASE_TOOL_HANDLERS",
    path: "src",
  });
  assert.match(text, /src\//, "files_with_matches output should list files under src/");
});

test("grep content mode returns matching lines with line numbers", { skip: !hasRipgrep() }, async () => {
  const text = await BASE_TOOL_HANDLERS.grep({
    pattern: "BASE_TOOL_HANDLERS",
    path: "src/tools.ts",
    output_mode: "content",
  });
  assert.match(text, /\d+:.*BASE_TOOL_HANDLERS/, "content mode should include `lineno:...` prefixes");
});

test("grep reports 'No matches found' when pattern is absent", { skip: !hasRipgrep() }, async () => {
  const text = await BASE_TOOL_HANDLERS.grep({
    pattern: "__definitely_not_present_needle_zzz__",
    path: "src",
  });
  assert.equal(text, "No matches found");
});

test("grep truncates output with head_limit notice", { skip: !hasRipgrep() }, async () => {
  // 故意用一个高命中率的 pattern + 很小的 head_limit 触发截断。
  const text = await BASE_TOOL_HANDLERS.grep({
    pattern: "the|and|of|to",
    path: "src",
    output_mode: "content",
    head_limit: 3,
  });
  assert.match(text, /Output truncated to first 3 of \d+ lines/);
});
