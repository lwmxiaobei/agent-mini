import assert from "node:assert/strict";
import test from "node:test";

import { formatUsageReport, type UsageResponse } from "../src/usage.js";

/**
 * 这些用例覆盖了 `/wham/usage` 真实返回里几种典型形态：
 *
 * 1. free plan：只暴露 primary_window（周窗口），secondary_window 为 null；
 * 2. plus plan：primary_window=5h 短窗口，secondary_window=7d 长窗口（codex 高频用户视角）；
 * 3. credits 充值用户：has_credits=true，需要展示 balance 和换算消息数；
 * 4. 命中限额：limit_reached=true，formatter 应明确给出告警行。
 *
 * 之所以测 formatter 而不是 fetch：fetch 走真实 HTTP 不可控，formatter 是纯函数，
 * 又恰好是用户最直接看到的输出，回归保护性价比最高。
 */

test("formatUsageReport 在 free plan 下只展示 primary 窗口", () => {
  const usage: UsageResponse = {
    email: "lwmlxy520@gmail.com",
    plan_type: "free",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 86,
        limit_window_seconds: 604800,
        reset_after_seconds: 577291,
        reset_at: 1778029261,
      },
      secondary_window: null,
    },
    credits: {
      has_credits: false,
      unlimited: false,
      overage_limit_reached: false,
      balance: null,
      approx_local_messages: null,
      approx_cloud_messages: null,
    },
    spend_control: { reached: false, individual_limit: null },
  };

  const report = formatUsageReport(usage);
  assert.match(report, /account\s+lwmlxy520@gmail\.com/);
  assert.match(report, /plan\s+free/);
  // primary 窗口应被识别为 7 天周窗口
  assert.match(report, /primary\s+\(7天窗口\)\s+86% used/);
  // secondary_window=null，formatter 必须老实地写 (n/a)，而不是凭空编一个 5h 窗口
  assert.match(report, /secondary\s+\(n\/a\)/);
  assert.match(report, /credits\s+none/);
  assert.match(report, /spend\s+ok/);
});

test("formatUsageReport 在 plus 用户的 5h+周窗口下能正确分别打标签", () => {
  const usage: UsageResponse = {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 5 * 3600,
        reset_after_seconds: 9000,
        reset_at: 1700000000,
      },
      secondary_window: {
        used_percent: 12,
        limit_window_seconds: 7 * 24 * 3600,
        reset_after_seconds: 432000,
        reset_at: 1700432000,
      },
    },
    credits: { has_credits: false, unlimited: false },
    spend_control: { reached: false },
  };

  const report = formatUsageReport(usage);
  // primary <= 6h，应该被识别成 5 小时窗口
  assert.match(report, /primary\s+\(5小时窗口\)\s+42% used/);
  // secondary >= 24h，应该被识别成 7 天窗口
  assert.match(report, /secondary\s+\(7天窗口\)\s+12% used/);
});

test("formatUsageReport 命中额度和有 credits 时给出对应展示", () => {
  const usage: UsageResponse = {
    plan_type: "pro",
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 5 * 3600,
        reset_after_seconds: 60,
        reset_at: 1700000000,
      },
      secondary_window: null,
    },
    credits: {
      has_credits: true,
      unlimited: false,
      overage_limit_reached: false,
      balance: 12.5,
      approx_local_messages: 250,
      approx_cloud_messages: 80,
    },
    spend_control: { reached: true, individual_limit: 50 },
    rate_limit_reached_type: "credits",
  };

  const report = formatUsageReport(usage);
  // 限额命中后应给出明显告警，不能只靠百分比让用户自己看出来
  assert.match(report, /⚠ limit reached/);
  assert.match(report, /credits\s+balance 12\.50/);
  assert.match(report, /250 local msgs \/ 80 cloud msgs/);
  assert.match(report, /spend\s+reached \(cap 50\)/);
  assert.match(report, /reached type: credits/);
});

test("formatUsageReport 在 unlimited credits 情况下直接显示 unlimited", () => {
  const usage: UsageResponse = {
    plan_type: "team",
    rate_limit: null,
    credits: { has_credits: true, unlimited: true },
    spend_control: null,
  };
  const report = formatUsageReport(usage);
  assert.match(report, /credits\s+unlimited/);
  // rate_limit 为 null 时不应崩，应显示 (no data)
  assert.match(report, /rate-limit\s+\(no data\)/);
});
