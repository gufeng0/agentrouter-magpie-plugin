import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRouterAuthPlugin, _internal } from './index.mjs';

const plugin = await AgentRouterAuthPlugin();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const apiMethod = (p) => p.auth.methods.find((m) => m.type === 'api');

test('Endpoint onboarding is absent and a previously misplaced key stays ignored', async () => {
  assert.deepEqual(apiMethod(plugin).prompts.map(p => p.key), ["username", "password"]);

  const { calls } = await readUsage(
    { key: 'sk-example', metadata: { endpoint: 'sk-example' } },
    [json({ total_usage: 0 })],
  );
  assert.equal(calls[0].url, 'https://ps.air-outer.com/v1/dashboard/billing/usage');
});

test('Provider editor headers are read as an object or rows', async () => {
  await AgentRouterAuthPlugin();
  assert.equal(_internal.headersOf({ headers: { 'User-Agent': 'mine' } }, {})['User-Agent'], 'mine');
  assert.equal(_internal.headersOf({ headers: [['X-Test', '1']] }, {})['X-Test'], '1');
  assert.equal(_internal.headersOf({ headers: 'X-Text: 2' }, {})['X-Text'], '2');
});

test('The Codex headers are sent unless the provider switch is turned off', async () => {
  // On — and on a host too old to offer the switch — the gateway sees the
  // client it admits. Off, the user's own headers are all that go.
  const withSwitch = (on) => AgentRouterAuthPlugin({ magpie: { option: () => on } });
  try {
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');

    await withSwitch(false);
    const off = _internal.headersOf({}, {});
    assert.equal(off['User-Agent'], undefined);
    assert.equal(off.Accept, 'application/json');
    assert.equal(
      _internal.headersOf({}, { metadata: { headers: 'User-Agent: mine' } })['User-Agent'],
      'mine',
    );

    await withSwitch(true);
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');

    // A host from before the switch hands over no reader at all.
    await AgentRouterAuthPlugin();
    assert.equal(_internal.headersOf({}, {})['User-Agent'], 'codex_cli_rs/0.101.0');
  } finally {
    await withSwitch(true);
  }
});

test('A retired model is never advertised back, whichever path lists it', async () => {
  // magpie's cached models.dev entry for this vendor still names models the
  // site has retired. The plugin's own list is what it answers with when the
  // vendor's list cannot be read, so those names cannot come back through it.
  const retired = ['claude-opus-5', 'claude-opus-4-8', 'deepseek-v4-flash', 'glm-5.3'];
  const declared = Object.keys(_internal.declaredModels());
  assert.deepEqual(declared, ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
  for (const id of retired) assert.ok(!declared.includes(id), `${id} must not be declared`);

  // No account yet: the vendor's list cannot be asked, and the row keeps the
  // plugin's list rather than the row's.
  const row = { models: { 'claude-opus-5': { name: 'x' }, 'gpt-6-astra': { name: 'y' } } };
  const listed = await plugin.provider.models(row);
  for (const id of retired) assert.ok(!(id in listed), `${id} must not be listed`);

  // The vendor refuses the list: same answer, not the row's.
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const fell = await plugin.provider.models(row, { auth: { key: 'sk-example' } });
    assert.deepEqual(Object.keys(fell), declared);
  } finally {
    globalThis.fetch = original;
  }
});

test('A content-filter refusal is explained, not left looking like a rate limit', async () => {
  // The vendor's filter answers refused text with 400 content-blocked. Waiting
  // or retrying never clears it, so an agent that reads it as a transient
  // gateway failure burns its budget repeating the same text forever.
  const original = globalThis.fetch;
  const blocked = JSON.stringify({
    error: {
      code: 'content-blocked',
      message: 'content-blocked (request id: abc)',
      type: 'agent_router_api_error',
    },
  });
  globalThis.fetch = async () =>
    new Response(blocked, { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.match(text, /content-blocked/);
    assert.match(text, /内容过滤器/);
    assert.match(text, /改写/);

    // magpie decides "may another provider retry this?" by matching quota /
    // rate-limit words in the body (fallback.go's retryable/quotaWords). If
    // the note reads like one of those, a hard refusal is retried on every
    // account and then fails over — surfacing as another provider's 429.
    // So the note must not contain any of them.
    const quotaWords =
      /quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i;
    assert.equal(quotaWords.test(text), false, 'the refusal must not read like a quota error');
  } finally {
    globalThis.fetch = original;
  }
});

test('A token-rate-limit 429 says it is a rate cap with a wait, not a spent account', async () => {
  // The vendor answers its per-minute token cap with 429 and no Retry-After,
  // and says nothing about when it lifts. magpie retries it on every account
  // (each retry spending more of the same counted tokens) and then fails over,
  // so the caller can end up seeing another provider's 429. Saying "wait a
  // minute" and sending Retry-After is what a caller can act on.
  const original = globalThis.fetch;
  const capped = JSON.stringify({
    message: 'Your requests to gpt-6.1-sol for gpt-6.1-sol in example-region have exceeded token rate limit.',
    type: 'api_error',
  });
  globalThis.fetch = async () =>
    new Response(capped, { status: 429, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    const text = await res.text();
    assert.match(text, /gpt-6\.1-sol/);
    assert.match(text, /一分钟后再试/);
    assert.match(text, /不保证届时已恢复/);
    // still a rate limit, so magpie keeps treating it as one (failRate)
    assert.match(text, /token rate limit/i);
  } finally {
    globalThis.fetch = original;
  }
});

test('A 429 that is not this cap is passed through untouched', async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ error: { code: 'insufficient_quota', message: 'out of quota' } });
  globalThis.fetch = async () =>
    new Response(body, { status: 429, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), null);
    assert.equal(await res.text(), body);
  } finally {
    globalThis.fetch = original;
  }
});

test('Any other refusal is passed through untouched', async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } });
  globalThis.fetch = async () =>
    new Response(body, { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    const p = await AgentRouterAuthPlugin();
    const loader = await p.auth.loader(async () => ({ key: 'sk-example' }), {});
    const res = await loader.fetch('https://agentrouter.org/v1/responses', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(await res.text(), body);
  } finally {
    globalThis.fetch = original;
  }
});

async function readUsage(auth, responses, provider = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    const response = responses.shift();
    assert.ok(response, `Unexpected request: ${url}`);
    return response;
  };
  try {
    return { usage: await plugin.auth.usage(async () => auth, provider), calls };
  } finally {
    globalThis.fetch = original;
  }
}

test('Cookie-only account reads remaining balance and real consumption', async () => {
  const { usage, calls } = await readUsage(
    { metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: 75000000, used_quota: 25000000 } })],
  );
  assert.equal(calls[0].headers.Cookie, 'session=example');
  assert.equal(calls[0].headers['New-Api-User'], '123');
  assert.equal(usage.balance, '$150.00');
  assert.equal(usage.windows[0].amount, 50);
  assert.equal(usage.windows[0].limit, 200);
  assert.equal(usage.windows[0].used, 25);
});

test('A quota read never signs in and never saves a session', async () => {
  // The password is for check-in, not for quota reads: a read with no saved
  // cookie tries the key's consumption only.
  const original = globalThis.fetch;
  const saved = [];
  const p = await AgentRouterAuthPlugin({ client: { auth: { set: async (payload) => saved.push(payload) } } });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return json({ total_usage: 123.45 });
  };
  try {
    const usage = await p.auth.usage(async () => ({ key: 'sk-example', metadata: { username: 'alice', password: 'hunter2' } }), {});
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/dashboard/billing/usage'));
    assert.equal(saved.length, 0);
    assert.match(usage.error, /不会重新登录|没有保存的 Cookie/);
    assert.equal(usage.balance, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('WAF-blocked balance falls back to account consumption without inventing remaining quota', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123' } },
    [new Response('<!doctype html><html>captcha</html>'), json({ success: true, data: { quota: 4500000 } })],
  );
  assert.ok(calls[1].url.endsWith('/api/log/self/stat'));
  assert.match(usage.error, /累计消耗 \$9\.00/);
  assert.match(usage.error, /剩余额度未知/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('Missing quota fields are not zero balance; key usage is converted from cents', async () => {
  const { usage, calls } = await readUsage(
    { key: 'sk-example', metadata: { accessToken: 'example', userId: '123', endpoint: 'https://relay.example' } },
    [json({ success: true, data: {} }), json({ success: false }), json({ total_usage: 12345.67 })],
  );
  assert.equal(calls[2].url, 'https://relay.example/v1/dashboard/billing/usage');
  assert.equal(calls[2].headers.Authorization, 'Bearer sk-example');
  assert.match(usage.error, /累计消耗 \$123\.46/);
  assert.equal(usage.balance, undefined);
});

test('Key-only account can report zero consumption without claiming zero balance', async () => {
  const { usage, calls } = await readUsage({ key: 'sk-example' }, [json({ total_usage: 0 })]);
  assert.equal(calls.length, 1);
  assert.match(usage.error, /累计消耗 \$0\.00/);
  assert.equal(usage.balance, undefined);
  assert.deepEqual(usage.windows, []);
});

test('A password-only account is not signed in for a quota read', async () => {
  const { usage, calls } = await readUsage(
    { metadata: { username: 'example', password: 'example' } },
    [],
  );
  assert.equal(calls.length, 0);
  assert.match(usage.error, /没有保存的 Cookie|不会用用户名密码重新登录/);
  assert.equal(usage.balance, undefined);
});

test('A stale cookie is not refreshed by a password login', async () => {
  const { usage, calls } = await readUsage(
    { metadata: { cookie: 'session=example', userId: '123', username: 'example', password: 'example' } },
    [json({ success: false, message: 'access token 无效' }), json({ success: true, data: { quota: 4500000 } })],
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => !String(c.url).includes('/api/user/login')));
  assert.ok(calls[1].url.endsWith('/api/log/self/stat'));
  assert.match(usage.error, /已失效/);
  assert.match(usage.error, /不会重新登录/);
  assert.match(usage.error, /累计消耗 \$9\.00/);
  assert.equal(usage.balance, undefined);
});

test('Malformed account and billing amounts stay unknown', async () => {
  const { usage } = await readUsage(
    { key: 'sk-example', metadata: { cookie: 'session=example', userId: '123' } },
    [json({ success: true, data: { quota: null, used_quota: 1 } }), json({ data: { quota: null } }), json({ total_usage: -1 })],
  );
  assert.match(usage.error, /没有返回额度字段/);
  assert.equal(usage.balance, undefined);
});
