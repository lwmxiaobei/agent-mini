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

  // CC 同款锁参数 retries=10/maxTimeout=100ms，对应真实场景几 agent 并发；
  // 单测取 10 并发足以验证锁的串行化效果，不模拟极端高并发。
  const senders = Array.from({ length: 10 }, (_, i) =>
    bus.send({ from: "alice", to: "lead", content: `msg-${i}` }),
  );
  await Promise.all(senders);

  const all = await bus.readAll("lead");
  assert.equal(all.length, 10);
  const texts = all.map((m) => m.text).sort();
  const expected = Array.from({ length: 10 }, (_, i) => `msg-${i}`).sort();
  assert.deepEqual(texts, expected);
});
