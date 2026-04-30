import {
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_USER_AGENT,
  OPENAI_CODEX_VERSION,
  createOpenAIOAuthFetch,
  getOpenAIOAuthDefaultHeaders,
} from "./oauth/openai.js";
import type { StoredOAuthCredentials } from "./config.js";

/**
 * ChatGPT backend 用于查询 Codex 订阅用量的端点。
 *
 * 为什么写成常量而不是直接拼接：
 * - 这个 URL 不属于公共 OpenAI API，而是 ChatGPT 内部的 codex 子域，
 *   未来如果迁移到 `/backend-api/codex/...` 之类的路径，集中改一处即可。
 * - 测试和调试时也方便直接 grep 出真实落点，避免重复字符串散落。
 */
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * 单个限额窗口的原始字段，与 ChatGPT backend 返回结构保持一致。
 *
 * 为什么不重命名字段：
 * - 这是上游契约，保持原名可以让排错时直接对照官方响应；
 * - 命令展示时再做语义化（短/长窗口、5h/周）即可，不用提前映射。
 */
export type RateLimitWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

export type CreditsInfo = {
  has_credits?: boolean;
  unlimited?: boolean;
  overage_limit_reached?: boolean;
  balance?: number | null;
  approx_local_messages?: number | null;
  approx_cloud_messages?: number | null;
};

export type SpendControl = {
  reached?: boolean;
  individual_limit?: number | null;
};

/**
 * `/wham/usage` 的精简返回结构。
 *
 * 为什么只声明用得上的字段：
 * - 上游字段会随产品调整而新增，全量声明会让类型定义和真实接口产生漂移；
 * - 真正驱动 UI 的就是 plan / 两个窗口 / credits / spend_control，
 *   其它字段（promo、referral_beacon 等）目前没有展示价值，留作 unknown 即可。
 */
export type UsageResponse = {
  user_id?: string;
  account_id?: string;
  email?: string;
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: RateLimitWindow | null;
    secondary_window?: RateLimitWindow | null;
  } | null;
  credits?: CreditsInfo | null;
  spend_control?: SpendControl | null;
  rate_limit_reached_type?: string | null;
};

/**
 * `/usage` 命令查询失败时携带的结构化信息。
 *
 * 为什么单独建一个 Error 子类：
 * - 上层既要友好地提示 "未登录 / token 失效"，又要在调试场景下保留 HTTP 状态码，
 *   普通 Error.message 拼字符串容易丢信息；
 * - 子类可以让调用方用 `instanceof` 判断是否是已知错误，从而决定是否暴露 raw body。
 */
export class UsageRequestError extends Error {
  public readonly status?: number;
  public readonly body?: string;

  constructor(message: string, options: { status?: number; body?: string } = {}) {
    super(message);
    this.name = "UsageRequestError";
    this.status = options.status;
    this.body = options.body;
  }
}

/**
 * 调用 ChatGPT backend `/wham/usage`，返回订阅与额度信息。
 *
 * 为什么这里要复用 oauth 模块的 fetch 与 headers：
 * - `createOpenAIOAuthFetch()` 已经接管了 HTTP_PROXY/NO_PROXY 等环境变量，
 *   保证用户在公司网络下也能复用同一套代理，无需另起一份逻辑；
 * - `getOpenAIOAuthDefaultHeaders()` 包含 codex CLI 期望的 `originator`、`Version`、
 *   `chatgpt-account-id` 等头部，缺一不可——backend 会按这些头部来识别"是 codex 在请求"
 *   并下发对应的限额视图。
 */
export async function fetchOpenAIUsage(
  credentials: StoredOAuthCredentials,
  options: { signal?: AbortSignal } = {},
): Promise<UsageResponse> {
  const accessToken = credentials.access_token?.trim();
  if (!accessToken) {
    throw new UsageRequestError("Missing OpenAI OAuth access token. Run /login first.");
  }

  const fetchImpl = createOpenAIOAuthFetch();
  // 这里要把 oauth 默认头部合并进来：包含 chatgpt-account-id、originator、Version 等
  // codex backend 需要的标识。Authorization 单独追加，避免被默认头部覆盖。
  const headers: Record<string, string> = {
    ...getOpenAIOAuthDefaultHeaders(credentials),
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  const response = await fetchImpl(OPENAI_USAGE_URL, {
    method: "GET",
    headers,
    signal: options.signal,
  });

  if (!response.ok) {
    // 把 body 一起带回去，便于调试 401（token 过期）/403（账号未启用 codex）等情况。
    const body = await safeReadText(response);
    throw new UsageRequestError(
      `Usage request failed: HTTP ${response.status}`,
      { status: response.status, body },
    );
  }

  const json = (await response.json()) as UsageResponse;
  return json;
}

/**
 * 安全读取 Response 文本：失败时返回空字符串。
 *
 * 为什么需要这层包装：
 * - 出错路径里如果再抛一个 "stream consumed twice" 之类的二次异常，
 *   会盖住真正的 HTTP 状态码，让排障难度直线上升；
 * - 即使 body 拿不到也不影响主错误的语义，所以这里吞掉异常是合理的。
 */
async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * 把 `limit_window_seconds` 翻译成人类语义的窗口名。
 *
 * 为什么不直接用上游 primary/secondary 名称：
 * - 不同 plan 下，"5h 短窗口" 可能落在 primary，也可能落在 secondary；
 * - 用窗口长度判断更稳：≤ 6h 视为短窗口（5h 滚动限额），≥ 24h 视为长窗口（周滚动限额），
 *   其它情况就老老实实叫 "window"，避免误导。
 */
function inferWindowLabel(rawLabel: string, windowSeconds?: number): string {
  if (typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds)) {
    return rawLabel;
  }
  const SIX_HOURS = 6 * 3600;
  const ONE_DAY = 24 * 3600;
  if (windowSeconds <= SIX_HOURS) {
    return `${rawLabel} (5小时窗口)`;
  }
  if (windowSeconds >= ONE_DAY) {
    const days = Math.round(windowSeconds / ONE_DAY);
    return `${rawLabel} (${days}天窗口)`;
  }
  return rawLabel;
}

/**
 * 把秒数格式成 "Xd Yh Zm" 的紧凑形式。
 *
 * 为什么不用 ISO duration 或 toLocale：
 * - 终端环境下短字符串比 ISO 串可读性更高；
 * - 不依赖 Intl.RelativeTimeFormat 也能跑在最低版本 Node 上。
 */
function formatDurationSeconds(totalSeconds?: number): string {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "-";
  }
  const seconds = Math.round(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  if (parts.length === 0) return "<1m";
  return parts.join(" ");
}

/**
 * 把 unix 秒时间戳转成本地可读时间。
 *
 * 为什么用 ISO + 替换：
 * - `toISOString()` 始终可用，不依赖 Intl 数据；
 * - 把 `T` 换成空格、去掉毫秒和 `Z` 后，就是终端里最直观的 `YYYY-MM-DD HH:MM:SS`，
 *   并且是 UTC，避免不同机器时区差异导致的歧义。
 */
function formatResetAt(resetAt?: number): string {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) {
    return "-";
  }
  const date = new Date(resetAt * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`;
}

function formatWindowLine(label: string, window: RateLimitWindow | null | undefined): string {
  if (!window) {
    return `${label}  (n/a)`;
  }
  const friendlyLabel = inferWindowLabel(label, window.limit_window_seconds);
  const used = typeof window.used_percent === "number" ? `${window.used_percent}% used` : "used -";
  const resetIn = `resets in ${formatDurationSeconds(window.reset_after_seconds)}`;
  const resetAt = `at ${formatResetAt(window.reset_at)}`;
  return `${friendlyLabel}  ${used} | ${resetIn} | ${resetAt}`;
}

function formatCreditsLine(credits: CreditsInfo | null | undefined): string {
  if (!credits) {
    return "credits   (n/a)";
  }
  if (credits.unlimited) {
    return "credits   unlimited";
  }
  if (!credits.has_credits) {
    return "credits   none";
  }
  const balance = typeof credits.balance === "number" ? credits.balance.toFixed(2) : "-";
  const local = typeof credits.approx_local_messages === "number" ? `${credits.approx_local_messages} local msgs` : "";
  const cloud = typeof credits.approx_cloud_messages === "number" ? `${credits.approx_cloud_messages} cloud msgs` : "";
  const extras = [local, cloud].filter(Boolean).join(" / ");
  const overage = credits.overage_limit_reached ? " | overage reached" : "";
  return `credits   balance ${balance}${extras ? ` | ${extras}` : ""}${overage}`;
}

function formatSpendLine(spend: SpendControl | null | undefined): string {
  if (!spend) {
    return "spend     (n/a)";
  }
  if (spend.reached) {
    const cap = typeof spend.individual_limit === "number" ? ` (cap ${spend.individual_limit})` : "";
    return `spend     reached${cap}`;
  }
  return "spend     ok";
}

/**
 * 把 `/wham/usage` 的响应格式成给终端展示的多行文本。
 *
 * 为什么把这一步抽成纯函数：
 * - 写单测时不需要起 HTTP，只要喂结构化对象即可；
 * - 终端展示不只 `/usage` 一处会用：未来想在 `/status` 里加一行用量摘要，
 *   也能直接复用同一个 formatter，避免出现两套对不上的展示口径。
 */
export function formatUsageReport(usage: UsageResponse): string {
  const rate = usage.rate_limit;
  const lines: string[] = [];

  lines.push(`account   ${usage.email ?? usage.account_id ?? usage.user_id ?? "-"}`);
  lines.push(`plan      ${usage.plan_type ?? "-"}`);
  lines.push("");

  if (!rate) {
    lines.push("rate-limit  (no data)");
  } else {
    if (rate.limit_reached) {
      lines.push("rate-limit  ⚠ limit reached");
    }
    lines.push(formatWindowLine("primary  ", rate.primary_window));
    lines.push(formatWindowLine("secondary", rate.secondary_window));
  }

  lines.push(formatCreditsLine(usage.credits));
  lines.push(formatSpendLine(usage.spend_control));

  if (usage.rate_limit_reached_type) {
    lines.push(`note      reached type: ${usage.rate_limit_reached_type}`);
  }

  return lines.join("\n");
}

/**
 * 暴露给 oauth.ts 调用方的标识，便于未来调试时确认 codex 与 xbcode 共用同一组 UA。
 *
 * 为什么 re-export：
 * - usage.ts 的调用方可能想在错误信息里附上当前 UA / Version；
 * - 直接从 oauth.ts 拿会让外层多一层 import，影响代码的纵向阅读体验。
 */
export const USAGE_DEBUG_INFO = {
  userAgent: OPENAI_CODEX_USER_AGENT,
  originator: OPENAI_CODEX_ORIGINATOR,
  version: OPENAI_CODEX_VERSION,
};
