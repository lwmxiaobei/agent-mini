import { Agent, EnvHttpProxyAgent, type Dispatcher } from "undici";

let streamingDispatcher: Dispatcher | undefined;
let proxyOnlyDispatcher: Dispatcher | undefined;

export function hasProxyEnvironment(): boolean {
  return [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ].some((value) => Boolean(value?.trim()));
}

/**
 * 一次性请求专用 dispatcher：
 * - 没有代理时返回 undefined，由 Node 默认 fetch 接管（保留原 OAuth 行为）。
 * - 有代理时用 EnvHttpProxyAgent，让请求遵循 shell 代理变量。
 */
export function getProxyOnlyDispatcher(): Dispatcher | undefined {
  if (!hasProxyEnvironment()) return undefined;
  if (!proxyOnlyDispatcher) proxyOnlyDispatcher = new EnvHttpProxyAgent();
  return proxyOnlyDispatcher;
}

/**
 * Streaming 请求专用 dispatcher：
 * - 没有代理时使用一条短 keep-alive 的 Agent，让闲置连接尽早从池里淘汰，
 *   避免在工具执行间隔后下一轮 stream 拿到一条已被远端 RST 的连接，
 *   然后立刻收到 undici 的 `TypeError: terminated`。
 * - 有代理时延用 EnvHttpProxyAgent，它自己负责池子生命周期。
 */
export function getStreamingDispatcher(): Dispatcher {
  if (streamingDispatcher) return streamingDispatcher;
  streamingDispatcher = hasProxyEnvironment()
    ? new EnvHttpProxyAgent()
    : new Agent({
        keepAliveTimeout: 1_000,
        keepAliveMaxTimeout: 5_000,
        connect: { timeout: 30_000 },
      });
  return streamingDispatcher;
}

type DispatcherInit = RequestInit & { dispatcher?: Dispatcher };
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createSharedFetch(): FetchLike {
  return async (input, init) => {
    const requestInit: DispatcherInit = { ...init, dispatcher: getStreamingDispatcher() };
    return await fetch(input, requestInit);
  };
}

const TRANSIENT_ERROR_CODES = new Set([
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
]);

/**
 * 判断错误是否值得重试一次 stream 请求。
 *
 * undici 在底层 socket 被远端关闭时抛出 `TypeError: terminated`，
 * 它的 message 可能是字面 "terminated"，也可能挂在 `cause` 上的 SocketError。
 * 这里把已知的传输层错误码也一起识别，避免误把模型/4xx 类错误当成可重试。
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };

  if (err.message === "terminated") return true;

  const code = typeof err.code === "string" ? err.code : undefined;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;

  const cause = err.cause as { message?: unknown; code?: unknown; name?: unknown } | undefined;
  if (cause) {
    if (cause.message === "terminated") return true;
    if (typeof cause.code === "string" && TRANSIENT_ERROR_CODES.has(cause.code)) return true;
    if (cause.name === "SocketError") return true;
  }

  return false;
}
