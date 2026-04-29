import test from "node:test";
import assert from "node:assert/strict";

import { appendTruncationNotice } from "../src/tools.js";

test("内容未达上限时原样返回", () => {
  assert.equal(appendTruncationNotice("short", 100), "short");
  assert.equal(appendTruncationNotice("", 100), "");
});

test("恰好等于上限时不追加提示", () => {
  const text = "a".repeat(100);
  assert.equal(appendTruncationNotice(text, 100), text);
});

test("超出上限时追加 'N lines truncated' 提示行", () => {
  const text = `${"a".repeat(50)}\nbbb\nccc\nddd`;
  const result = appendTruncationNotice(text, 50);
  assert.match(result, /\.\.\. \[\d+ lines truncated\] \.\.\.$/);
  assert.ok(result.startsWith("a".repeat(50)));
});

test("剩余行数包含被截断那一行（即使最后一行不完整）", () => {
  // 前 5 字节 "aaaaa" 截到第一行中间，剩余 "aaaaa\nbbb" — 1 个换行 + 末尾还有 "bbb"
  // dropped = "aaaaa\nbbb"，换行数 1，行数 = 1 + 1 = 2
  const text = "aaaaaaaaaa\nbbb";
  const result = appendTruncationNotice(text, 5);
  assert.match(result, /\[2 lines truncated\]/);
});

test("末尾以换行结尾时不会少算行数", () => {
  // dropped = "ddd\n"，换行数 1，行数 = 1 + 1 = 2（含末尾空行）
  const text = "aaa\nbbb\nccc\nddd\n";
  const result = appendTruncationNotice(text, 8);
  assert.match(result, /\[\d+ lines truncated\]/);
});

test("提示行格式与 Claude Code BashTool 一致", () => {
  const text = "x".repeat(200);
  const result = appendTruncationNotice(text, 100);
  // Claude Code 格式：内容\n\n... [N lines truncated] ...
  assert.match(result, /\n\n\.\.\. \[\d+ lines truncated\] \.\.\.$/);
});
