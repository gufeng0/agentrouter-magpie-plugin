import assert from "node:assert/strict";
import { test } from "node:test";

import plugin from "./index.mjs";

const auth = (over = {}) => ({
  type: "api",
  key: "synthetic-model-key",
  metadata: { site: "air", username: "alice", password: "hunter2", ...over },
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function checkin(authValue, response, expectedCalls = 1) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response;
  };
  try {
    const p = await plugin();
    const result = await p.auth.checkin(async () => authValue, {});
    assert.equal(calls, expectedCalls);
    return result;
  } finally {
    globalThis.fetch = original;
  }
}

test("a true marker claims the day", async () => {
  const r = await checkin(auth(), json({ success: true, data: { id: 1, checked_in: true } }));
  assert.equal(r.outcome, "claimed");
  assert.match(r.message, /签到成功/);
});

test("a false marker reports done, not a failure", async () => {
  const r = await checkin(auth(), json({ success: true, data: { id: 1, checked_in: false } }));
  assert.equal(r.outcome, "done");
  assert.match(r.message, /未新增/);
});

for (const value of [undefined, null, "true", 1]) {
  test("a missing/non-boolean marker is not success: " + value, async () => {
    const r = await checkin(auth(), json({ success: true, data: { id: 1, checked_in: value } }));
    assert.equal(r.outcome, "failed");
    assert.match(r.message, /标记|无法确认/);
  });
}

test("a wrong site password settles for the day", async () => {
  const r = await checkin(auth(), json({ success: false, message: "用户名或密码错误，或用户已被封禁" }));
  assert.equal(r.outcome, "ineligible");
  assert.match(r.message, /请核对|重新登录/);
});

test("an account without a site password is ineligible", async () => {
  const r = await checkin({ type: "api", key: "synthetic-model-key", metadata: { site: "air" } }, json({ success: true, data: {} }), 0);
  assert.equal(r.outcome, "ineligible");
  assert.match(r.message, /用户名和密码|API Key/);
});

test("a WAF HTML answer is a retryable failure", async () => {
  const r = await checkin(auth(), new Response("<!doctype html><html>slider</html>", { status: 200, headers: { "content-type": "text/html" } }));
  assert.equal(r.outcome, "failed");
  assert.match(r.message, /验证码|防火墙/);
});

test("one site account, no typed API key", async () => {
  const p = await plugin();
  assert.deepEqual(p.auth.methods.map((m) => m.type), ["api"]);
  assert.deepEqual(p.auth.methods[0].prompts.map((x) => x.key), ["username", "password"]);
  assert.equal(p.auth.methods[0].label, "AgentRouter（站点账号）");
  assert.equal(p.auth.methods[0].placeholder, undefined);
});

test("sign-in reads the model key from the account's token list", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, headers: new Headers(init.headers) });
    if (u.pathname === "/api/user/login") {
      return new Response(JSON.stringify({ success: true, data: { id: 113947, username: "alice", quota: 1000000, used_quota: 0, checked_in: true } }), {
        headers: { "content-type": "application/json", "set-cookie": "session=abc; Path=/; HttpOnly" },
      });
    }
    if (u.pathname === "/api/token/") {
      assert.equal(new Headers(init.headers).get("Cookie"), "session=abc");
      assert.equal(new Headers(init.headers).get("New-Api-User"), "113947");
      return Response.json({ success: true, data: { items: [
        { id: 1, status: 1, key: "sk-auto", expired_time: -1, remain_quota: 100, unlimited_quota: false },
      ] } });
    }
    throw new Error("unexpected " + u.pathname);
  };
  try {
    const p = await plugin();
    const r = await p.auth.methods[0].authorize({ username: "alice", password: "hunter2" });
    assert.equal(r.type, "success");
    assert.equal(r.key, "sk-auto");
    assert.equal(r.metadata.site, "air");
    assert.equal(r.metadata.username, "alice");
    assert.equal(r.metadata.email, "alice");
    assert.equal(r.metadata.password, "hunter2");
    assert.equal(r.metadata.userId, "113947");
    assert.ok(calls.some((c) => c.path === "/api/token/"));
  } finally {
    globalThis.fetch = original;
  }
});
