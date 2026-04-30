import test from "node:test";
import assert from "node:assert/strict";

import { isTransientNetworkError } from "../src/http.js";

test("isTransientNetworkError 识别 undici 抛出的字面 'terminated' 消息", () => {
  const err = new TypeError("terminated");
  assert.equal(isTransientNetworkError(err), true);
});

test("isTransientNetworkError 识别挂在 cause 上的 SocketError", () => {
  const cause = new Error("other side closed");
  (cause as any).name = "SocketError";
  const err: any = new TypeError("fetch failed");
  err.cause = cause;
  assert.equal(isTransientNetworkError(err), true);
});

test("isTransientNetworkError 识别已知 ECONNRESET / UND_ERR_SOCKET 等错误码", () => {
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT", "EPIPE"]) {
    const err: any = new Error("network");
    err.code = code;
    assert.equal(isTransientNetworkError(err), true, `expected ${code} to be transient`);
  }
});

test("isTransientNetworkError 通过 cause.code 识别 transient 错误", () => {
  const cause: any = new Error("boom");
  cause.code = "UND_ERR_BODY_TIMEOUT";
  const err: any = new TypeError("fetch failed");
  err.cause = cause;
  assert.equal(isTransientNetworkError(err), true);
});

test("isTransientNetworkError 不会误把 4xx/普通错误当 transient", () => {
  assert.equal(isTransientNetworkError(new Error("Bad Request")), false);
  const apiErr: any = new Error("rate limited");
  apiErr.code = "rate_limit_exceeded";
  assert.equal(isTransientNetworkError(apiErr), false);
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError(undefined), false);
  assert.equal(isTransientNetworkError("terminated"), false);
});
