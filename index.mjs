import { explainResponse } from "./response.mjs";
import { prepareRequest } from "./request.mjs";
import { loadTextFilter } from "./content-filter.mjs";

// AgentRouter (ps.air-outer.com, the China site) for magpie.
//
// 1. Model provider. The vendor's gateway only answers clients it
//    recognises; a browser/curl User-Agent gets "unauthorized client
//    detected" even with a good key. Requests default to the Codex client's
//    headers, configurable per provider/account. The site serves the
//    Responses API only, so the provider speaks Responses and the gateway
//    translates Chat/Anthropic requests. `request.mjs` rewrites node-bound
//    Responses state and applies the local content filter;
//    `response.mjs` preserves successful bytes and explains refusals.
//
// 2. Balance/usage. /api/user/self reports `quota` and `used_quota`; it is
//    often behind an Aliyun slider-captcha, so a password sign-in is used
//    as a fallback. A key-only account reports consumption, never an
//    invented remaining balance.
//
// 3. Daily check-in. The site has no /api/user/checkin (that path falls
//    through to New API's admin route and answers 权限不足). The daily
//    DailyCheckinQuota is granted at sign-in: the login response's
//    `checked_in` says whether *this* login granted it. The plugin keeps
//    the site username/password to log in once a day.
//
// No GitHub authorization: the only sign-in method is the site account
// plus the model API key. Derived from ZhaoJun233/agentrouter-magpie-plugin
// and 22952497/agentrouter-magpie (MIT); GitHub/local-checkin code removed.

const PROVIDER = "agentrouter";

// The request endpoint: where completions and the model list go. This is the
// one the user picked, and it stays what they picked even when the site the
// check-in talks to is the other front door. A site's own API lives under it.
const ENDPOINT = "https://ps.air-outer.com";

const SITES = {
  // The vendor runs two front doors for the same accounts. `api` is the
  // request endpoint a site serves; `site` is where its web routes are.
  org: { name: "AgentRouter", api: "https://agentrouter.org", site: "https://agentrouter.org" },
  air: { name: "AgentRouter (ps.air-outer.com)", api: "https://ps.air-outer.com", site: "https://ps.air-outer.com" },
};

// What the vendor's own clients send. codex_cli_rs is what its gateway
// admits; the rest are the headers a Codex CLI sends beside it.
const DEFAULT_HEADERS = {
  "User-Agent": "codex_cli_rs/0.101.0",
  Accept: "application/json",
};

// How many model keys one list read covers. A count at the page size means
// the list was cut, not that the account has that many.

// Models are listed by the vendor, so this is only what to show before a
// sign-in and the shape (limits, tool calls) each listed model takes.
const MODEL_SHAPE = {
  name: undefined,
  limit: { context: 300000, output: 128000 },
  tool_call: true,
  reasoning: true,
};

// The models this plugin itself ships, by the name to show them under. They
// are what the row lists before the vendor's own list arrives — and what it
// falls back to when that list cannot be read.
//
// magpie also keeps a models.dev catalog, and its cached entry for this
// vendor still carries models the site has retired (see README, "模型列表从
// 哪来"). Falling back to the row's current models would re-advertise them,
// so the fallback is built from this table instead: a model shown here is one
// this plugin vouches for.
const DECLARED_MODELS = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
};

// codexHeaders is whether requests are sent as a Codex CLI's, as the
// provider's own switch has it. The switch is the vendor's whitelist made
// optional: off, only the headers the user gave are sent. It is read from the
// host when the plugin loads (magpie hands the reader over as input.magpie),
// and defaults to on — including on a host too old to have the switch, which
// is why the option is checked for rather than assumed.
let codexHeaders = () => true;

const REQUEST_TIMEOUT = 30_000;
const CHECKIN_TIMEOUT = 25_000;

const siteOf = (id) => SITES[id] ?? SITES.air;

// Two of the three sign-in methods ask these first, so they are named once.
// The host reads them the way the plugin's own prompts gave them: the site
// pick first, then the system access token that is not a model Key.
function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

// parseHeaders turns the one-header-per-line text an account keeps into an
// object. A line is "Name: value"; blank lines and lines starting with #
// are skipped, so a block copied out of a browser's devtools works as it
// is. A name repeated keeps its last value, as a Headers object would.
function parseHeaders(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const at = s.indexOf(":");
    if (at < 1) continue;
    const name = s.slice(0, at).trim();
    const value = s.slice(at + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

// modelHeaders is the header block the provider's editor keeps on a model:
// info() merges each model's `headers` from the plugin's config, and magpie's
// provider editor writes the user's own there. It is the place a header can
// be changed after sign-in without signing in again, so it is read here as
// the provider's own block.
function modelHeaders(provider) {
  const models = provider?.models;
  if (!models || typeof models !== "object") return {};
  const out = {};
  for (const m of Object.values(models)) {
    if (m && typeof m.headers === "object" && m.headers) Object.assign(out, m.headers);
  }
  return out;
}

// headerObject reads a header block in the shapes magpie and this plugin
// keep: a text block ("Name: value" lines), the provider editor's object
// ({Name: value}) or its rows ([[Name, value], …]).
function headerObject(value) {
  if (!value) return {};
  if (typeof value === "string") return parseHeaders(value);
  const out = {};
  const put = (name, val) => {
    const n = String(name ?? "").trim();
    const v = String(val ?? "").trim();
    if (n && v) out[n] = v;
  };
  if (Array.isArray(value)) {
    for (const row of value) {
      if (Array.isArray(row)) put(row[0], row[1]);
      else if (row && typeof row === "object") put(row.name ?? row.key, row.value);
    }
    return out;
  }
  if (typeof value === "object") {
    for (const [name, val] of Object.entries(value)) put(name, val);
  }
  return out;
}

// headersOf is what a request to the vendor is sent with, lowest to highest:
// the defaults, the provider's own block (its models' headers, which the
// editor keeps), and the account's own, each overriding the one before it.
//
// The Codex User-Agent is the switch's business; Accept is not a client
// claim, so it stays whatever the switch says.
function headersOf(provider, auth) {
  return {
    ...(codexHeaders() ? { "User-Agent": DEFAULT_HEADERS["User-Agent"] } : {}),
    Accept: DEFAULT_HEADERS.Accept,
    ...modelHeaders(provider),
    ...headerObject(provider?.headers),
    ...parseHeaders(headersText(auth)),
  };
}

// applyHeaders sets headers on a Headers object, dropping any whose value is
// empty so a user can take one off by clearing it.
function applyHeaders(h, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === "") h.delete(k);
    else h.set(k, String(v));
  }
  return h;
}

// isURLish says whether a value can be a base URL at all: an http(s) address.
// The endpoint question is free text, so a key pasted into it — which is what
// the account manager's first question invites, since it is where the key
// used to go — lands in the same field as a real address does. Such a value
// is not an endpoint however it was stored, and building a base out of it
// sends every request to nothing at all, with no error to show for it.
function isURLish(v) {
  return /^https?:\/\/\S+$/i.test(String(v ?? "").trim());
}

// apiBase is the base completions go to. It follows the account's own
// endpoint when it gave one, and otherwise the endpoint this plugin was built
// for — never the check-in site, so picking ps.air-outer.com for the check-in
// doesn't quietly move requests off agentrouter.org.
//
// A stored endpoint that isn't a URL is ignored rather than used: the
// request then still goes to the vendor, which is what the account wanted
// when it pasted a key there.
function apiBase(provider, auth) {
  const said = String(meta(auth, "endpoint") ?? provider?.endpoint ?? "").trim();
  if (isURLish(said)) return `${said.replace(/\/+$/, "")}/v1`;
  const base = String(meta(auth, "apiBase") ?? "").trim();
  if (base) return base.replace(/\/+$/, "");
  return `${siteOf(siteName(auth) || provider?.site).api.replace(/\/+$/, "")}/v1`;
}

// siteBase is where the site's own web routes are: the balance and the
// check-in. It follows the site the account signed in to, not the request
// endpoint, since a front door's web routes are its own.
function siteBase(provider, auth) {
  const said = String(meta(auth, "siteURL") ?? provider?.siteURL ?? "").trim();
  if (said) return said.replace(/\/+$/, "");
  return siteOf(siteName(auth) || provider?.site).site;
}

// meta reads a field the account keeps, whether magpie hands the auth as the
// flat record ({type, key, accessToken, …}) or with the sign-in's answers
// under metadata ({type, key, metadata: {accessToken, …}}). Both shapes reach
// a hook: the flat one from the store, the nested one from what authorize
// returned, so every reader goes through here.
function meta(auth, name) {
  if (!auth) return undefined;
  const flat = auth[name];
  if (flat !== undefined && flat !== null && String(flat).trim() !== "") return flat;
  const nested = auth.metadata?.[name];
  return nested === undefined || nested === null ? undefined : nested;
}

// userToken is the credential the site's own /api/user routes take: the
// access token from the profile page. An sk- key is not one of those, and
// sending it there is what makes the balance read as "access token 无效".
function userToken(auth) {
  return String(meta(auth, "accessToken") ?? "").trim();
}

// apiKey is the credential completions take.
function apiKey(auth) {
  return String(auth?.key ?? "").trim();
}

// userId is the New-Api-User header's value. A New API site answers 401 to
// a session that is good but doesn't say which user it is, so the account
// keeps the id beside the token.
function userId(auth) {
  return String(meta(auth, "userId") ?? "").trim();
}

// headersText is the account's own header block, if it gave one.
function headersText(auth) {
  return String(meta(auth, "headers") ?? "");
}

// cookieText is the browser cookie the account copied from the site.
// A valid session authenticates user reads. WAF can still challenge those
// reads even when the same Cookie works in a browser.
function cookieText(auth) {
  return String(meta(auth, "cookie") ?? "").trim();
}

// parseCookies turns the text a browser shows for a site ("a=1; b=2", or
// the tab-separated lines of a devtools cookie table) into a Cookie header.
// A name repeated keeps its last value, as the browser's own send would.
function parseCookies(text) {
  const out = [];
  const seen = new Map();
  for (const raw of String(text ?? "").split(/\r?\n|;/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    // A devtools row is "name<TAB>value<TAB>domain…"; a plain pair is
    // "name=value". Both keep only the first two fields.
    const cols = s.split("\t");
    let name, value;
    if (cols.length > 1) {
      name = cols[0].trim();
      value = (cols[1] ?? "").trim();
    } else {
      const at = s.indexOf("=");
      if (at < 1) continue;
      name = s.slice(0, at).trim();
      value = s.slice(at + 1).trim();
    }
    if (!name) continue;
    if (seen.has(name)) out[seen.get(name)] = `${name}=${value}`;
    else {
      seen.set(name, out.length);
      out.push(`${name}=${value}`);
    }
  }
  return out.join("; ");
}

// siteName is the site the account signed in to.
function siteName(auth) {
  return String(meta(auth, "site") ?? "air");
}

// userHeaders are what a /api/user call carries: the access token, the user
// id when the account knows it, and the browser cookie that gets past the
// WAF when the account has one.
function userHeaders(provider, auth) {
  const h = headersOf(provider, auth);
  if (userToken(auth)) h.Authorization = userToken(auth);
  else delete h.Authorization;
  delete h["Content-Type"];
  if (userId(auth)) h["New-Api-User"] = userId(auth);
  const cookie = parseCookies(cookieText(auth));
  if (cookie) h.Cookie = cookie;
  return h;
}


async function jsonOrText(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: undefined, text };
  }
}

// ---- signing in with GitHub ---------------------------------------------------

// The site's own callback page (/oauth/github) is a route in its single-page
// app, and that route redeems the code the instant it loads — so by the time
// the user has copied the address out of the browser, the code is already
// spent and the exchange here fails with "code is incorrect or expired".
//
// A path *under* that one is not a route, so the app shows its "page not
// found" screen and leaves the code alone, which is what this needs. GitHub
// matches a callback against a subdirectory of the registered URL, and the
// site's own token exchange does not send redirect_uri at all, so the URL
// used here only has to survive the authorize step.
//
// No other provider gets the same treatment: every other site the vendor
// runs signs in inside its own app, which spends the code on the callback
// route before the address bar can be read (linuxdo-login, verified against
// the real site's bundle). Nothing here redirects to those routes, so a
// browser sign-in hands the code to the app, not to this plugin.
function keyProblem(kind) {
  const messages = {
    invalidId: "模型 Key ID 需为纯数字，或留空",
    missing: "账号下没有启用且完整的模型 Key",
    ambiguous: "存在多个不同的模型 Key，无法确定使用哪一个",
    incomplete: "模型 Key 列表可能不完整，无法确定唯一候选",
    rejected: "站点拒绝读取模型 Key，请确认账号状态和登录权限",
    "no-session": "站点登录成功，但响应里没有会话 Cookie",
    blocked: "读取模型 Key 时遇到站点验证页",
    unsupported: "站点返回的模型 Key 列表格式无法确认",
    upstream: "站点暂时无法提供模型 Key 列表",
    network: "读取模型 Key 的网络请求失败或超时",
  };
  return messages[kind] ?? "无法读取模型 Key";
}


function usableModelKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  return key !== "" && !["agentrouter", "your_api_key"].includes(key.toLowerCase()) && !/[*…<>]|\.\.\.|\s/.test(key);
}

function enabledModelKey(item) {
  if (item?.status !== 1 || !usableModelKey(item.key)) return null;
  const expiry = item.expired_time;
  const now = Date.now() / 1000;
  if (expiry != null && (typeof expiry !== "number" || !Number.isFinite(expiry) || (expiry !== -1 && expiry <= now))) return null;
  return item.key.trim();
}


// pickModelKey chooses one of the account's own model keys: the enabled,
// complete, unexpired one with the most room. It is what lets the sign-in
// fetch a key rather than ask the user to paste one.
function pickModelKey(json) {
  const data = json?.data;
  const items = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(items)) return { kind: "unsupported" };
  const valid = [];
  for (const item of items) {
    const key = enabledModelKey(item);
    if (!key) continue;
    const remain = Number(item.remain_quota);
    valid.push({
      key,
      unlimited: item.unlimited_quota === true ? 1 : 0,
      remain: Number.isFinite(remain) ? remain : -1,
      id: Number(item.id) || 0,
    });
  }
  if (!valid.length) return { kind: "missing" };
  valid.sort((a, b) => b.unlimited - a.unlimited || b.remain - a.remain || b.id - a.id);
  return { kind: "found", key: valid[0].key };
}

// sessionModelKey reads the account's model keys with the session its
// username/password sign-in just received. New API wants both the session
// cookie and the numeric user id on /api/token.
async function sessionModelKey(provider, auth, login) {
  if (!login?.cookie || !login?.userId) return { kind: "no-session" };
  try {
    const res = await fetch(`${siteBase(provider, auth)}/api/token/?p=1&page_size=100`, {
      headers: { ...DEFAULT_HEADERS, Cookie: login.cookie, "New-Api-User": login.userId },
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    if (!json && /^\s*</.test(String(text))) return { kind: "blocked" };
    if (res.status === 401 || res.status === 403) return { kind: "rejected" };
    if (!res.ok) return { kind: "upstream" };
    if (json?.success === false) return { kind: "rejected" };
    return pickModelKey(json);
  } catch {
    return { kind: "network" };
  }
}

// sessionOf pulls the site's session cookie out of a response. The site
// answers a sign-in by setting `session` rather than by putting a token in
// the body; getSetCookie() keeps each Set-Cookie apart, and a runtime
// without it gives one joined header, which the session match still reads.
function sessionOf(res) {
  let lines = [];
  try {
    if (typeof res.headers.getSetCookie === "function") lines = res.headers.getSetCookie() ?? [];
  } catch {
    lines = [];
  }
  if (!lines.length) {
    const joined = res.headers.get("set-cookie");
    if (joined) lines = [joined];
  }
  for (const line of lines) {
    const m = /(?:^|[;,])\s*session=([^;,\s]+)/.exec(String(line));
    if (m) return m[1];
  }
  return "";
}

// signIn is one POST to the site's login route, and it is the whole feature:
// the login response carries both the day's check-in and the balance.
//
// The vendor grants its daily credit at sign-in rather than through a route
// of its own — its front end says "签到成功，新增额度已到账" when the login
// response has checked_in — and that same response carries quota and
// used_quota, the account's balance. So one call does both jobs, and it is
// also the only way to read the balance from a server: /api/user/self, the
// route New API normally reads it from, is the one this site's WAF answers
// with a slider captcha, while /api/user/login is left alone.
//
// It answers {ok, checkedIn?, balance?, why?}. The caller decides whether a
// false `ok` is the account's to fix (wrong password) or nobody's (the site
// is down), so the reasons stay distinguishable here.
async function signIn(provider, auth) {
  const user = String(meta(auth, "username") ?? "").trim();
  const pass = String(meta(auth, "password") ?? "");
  if (!user || !pass) return { ok: false, why: "no-password" };
  const h = headersOf(provider, auth);
  h["Content-Type"] = "application/json";
  delete h.Authorization;
  let res;
  try {
    res = await fetch(`${siteBase(provider, auth)}/api/user/login`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ username: user, password: pass }),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
  const { json, text } = await jsonOrText(res);
  if (!json) {
    if (/^\s*<(?:!doctype|html)/i.test(String(text))) return { ok: false, why: "blocked", blocked: true };
    return { ok: false, why: `HTTP ${res.status}` };
  }
  if (json.success === false) {
    const msg = String(json.message ?? json.msg ?? "");
    // The site words a wrong password and a banned account the same way, so
    // this is "the site refused these credentials", which is the account's
    // to fix.
    if (/密码|password|封禁|banned|错误/i.test(msg)) return { ok: false, why: "bad-password", message: msg };
    return { ok: false, why: msg || "refused", message: msg };
  }
  const d = json.data ?? {};
  const quota = quotaNumber(d.quota);
  const used = quotaNumber(d.used_quota);
  // Two zero counters are New API's loading state, not an empty account:
  // a real zero balance with historical use still has used_quota above 0.
  const pending = Number.isFinite(quota) && Number.isFinite(used) && quota === 0 && used === 0;
  const balance =
    !pending && Number.isFinite(quota) && Number.isFinite(used)
      ? { quota, used, name: d.username ?? d.display_name ?? "" }
      : undefined;
  if (balance) balance.total = balance.quota + balance.used;
  const session = sessionOf(res);
  // `checked_in: true` means *this* sign-in granted the day's credit. A false
  // means no new grant; a missing/non-boolean marker proves nothing.
  return {
    ok: true,
    checkedIn: d.checked_in,
    balance,
    pending,
    name: d.username ?? d.display_name ?? "",
    cookie: session ? `session=${session}` : "",
    userId: String(d.id ?? ""),
  };
}

// keepSession writes back the session a successful sign-in just received, so
// quota reads can use it without logging in again. The site hands out a new
// `session` cookie on every login; without this, the cookie from check-in was
// thrown away and every quota read logged in afresh. Best effort: a failed
// save must not turn a good sign-in into a failure.
async function keepSession(client, auth, session) {
  if (!client?.auth?.set || !session?.cookie) return;
  const cookie = String(session.cookie).trim();
  const userId = String(session.userId ?? "").trim();
  if (cookie === String(meta(auth, "cookie") ?? "").trim() &&
      (!userId || userId === String(meta(auth, "userId") ?? "").trim())) return;
  const metadata = { ...(auth?.metadata ?? {}), cookie };
  if (userId) metadata.userId = userId;
  // The flat shape is what some hooks receive; keep both readings in step.
  const body = { ...auth, cookie, metadata };
  if (userId) body.userId = userId;
  try {
    await client.auth.set({ path: { id: PROVIDER }, body });
  } catch {
    // The sign-in stands even when the session can't be kept.
  }
}

// Try the saved session only; a quota read never signs in. The password is
// for check-in and the model key, and check-in is what keeps the session
// fresh. If the cookie has gone stale, the card says so until the next
// check-in rather than logging in again behind the user's back.
async function balance(provider, auth) {
  return balanceByToken(provider, auth);
}

// Read /api/user/self with either an access token or a browser session.
async function balanceByToken(provider, auth) {
  if (!userToken(auth) && !parseCookies(cookieText(auth))) return { ok: false, why: "no-token" };
  try {
    const res = await fetch(`${siteBase(provider, auth)}/api/user/self`, {
      headers: userHeaders(provider, auth),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json, text } = await jsonOrText(res);
    // New API answers 200 with success:false for a token it refuses, so the
    // status alone doesn't say; the body does.
    if (json && json.success === false) {
      const msg = String(json.message ?? "");
      if (/access\s*token|token.*(无效|invalid)|未登录/i.test(msg)) return { ok: false, why: "expired", expired: true };
      return { ok: false, why: msg || "refused" };
    }
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    // The site sits behind a WAF that answers an HTML slider-captcha page
    // with 200 instead of the JSON: saying "<!doctype html>" back to the
    // user hides the real problem, which is that the read was blocked and a
    // sign-in is what gets past it.
    if (!json) {
      if (/^\s*<(?:!doctype|html)/i.test(String(text))) {
        return { ok: false, why: "blocked", blocked: true };
      }
      return { ok: false, why: String(text).slice(0, 80) };
    }
    const d = json.data ?? {};
    const quota = quotaNumber(d.quota);
    const used = quotaNumber(d.used_quota);
    if (!Number.isFinite(quota) || !Number.isFinite(used)) return { ok: false, why: "no-quota" };
    if (quota === 0 && used === 0) return { ok: false, why: "pending", pending: true };
    return { ok: true, balance: { quota, used, total: quota + used, name: d.username ?? d.display_name ?? "" } };
  } catch (e) {
    return { ok: false, why: `unreachable: ${e?.message ?? String(e)}` };
  }
}

// These endpoints report cumulative consumption, never remaining credit.
async function spendOf(provider, auth) {
  const rate = quotaRate(provider);
  const reads = [];
  if (userToken(auth) || parseCookies(cookieText(auth))) {
    reads.push({
      url: `${siteBase(provider, auth)}/api/log/self/stat`,
      headers: userHeaders(provider, auth),
      field: "quota",
      divisor: rate,
    });
  }
  if (apiKey(auth)) {
    reads.push({
      url: `${apiBase(provider, auth)}/dashboard/billing/usage`,
      headers: { ...headersOf(provider, auth), Authorization: `Bearer ${apiKey(auth)}` },
      field: "total_usage",
      divisor: 100,
    });
  }
  for (const read of reads) {
    try {
      const res = await fetch(read.url, { headers: read.headers, signal: withTimeout(REQUEST_TIMEOUT) });
      const { json } = await jsonOrText(res);
      if (!res.ok || !json || json.success === false) continue;
      const value = (json.data ?? json)[read.field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      return { ok: true, spent: value / read.divisor };
    } catch {
      // A failed user read must not prevent the independent key fallback.
    }
  }
  return { ok: false };
}

function quotaNumber(value) {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function quotaRate(provider) {
  const rate = Number(provider?.quotaPerUnit ?? 500000);
  return Number.isFinite(rate) && rate > 0 ? rate : 500000;
}

// magpie cannot show a percent-free consumption window. Use its text status
// for partial data so spend never becomes a balance or an invented 0% window.
async function usageOf(getAuth, provider) {
  const auth = await getAuth();
  if (!auth) return { windows: [] };
  const b = await balance(provider, auth);
  if (!b.ok) {
    const spend = await spendOf(provider, auth);
    if (spend.ok) {
      const reason = b.blocked
        ? "余额接口被滑动验证码拦截"
        : b.pending ? "网站余额仍在加载，稍后刷新"
        : b.expired ? "保存的 Cookie/访问令牌已失效" : "余额接口未返回可用余额";
      return {
        error: `AgentRouter：累计消耗 $${spend.spent.toFixed(2)}；剩余额度未知（${reason}）。余额读取只用保存的 Cookie/访问令牌，不会重新登录；签到会保存新的 Cookie`,
        windows: [],
      };
    }
    const why =
      b.expired
        ? "AgentRouter：保存的 Cookie/访问令牌已失效，不会重新登录；等下次签到保存新 Cookie 后再读"
        : b.blocked
          ? "AgentRouter：余额接口被滑动验证码拦截，剩余额度未知。Cookie 不能保证通过验证码；签到后会用新的 Cookie 再试"
          : b.pending ? "AgentRouter：网站余额仍在加载，尚无本地缓存，请稍后刷新"
          : b.why === "no-token"
            ? "AgentRouter：账号里没有保存的 Cookie 或访问令牌，无法读取余额；不会用用户名密码重新登录，签到后会保存 Cookie"
            : b.why === "no-quota"
              ? "AgentRouter：站点没有返回额度字段"
              : `AgentRouter：无法读取余额（${b.why}）`;
    return { error: why, windows: [] };
  }
  const bal = b.balance;
  // The site counts in 1/500000 dollars unless it says otherwise.
  const rate = quotaRate(provider);
  const dollars = (n) => Math.round((n / rate) * 100) / 100;

  // New API's fields, as the site's own dashboard labels them:
  //   quota      the balance left now      ("当前余额")
  //   used_quota what has been spent       ("历史消耗")
  //   both       the credit the account was given
  // magpie's window wants Used and Remaining as *percent*, with the counts
  // beside them in Amount/Limit/Unit — putting the dollars into Used is what
  // can make a positive balance read as "0% left" when a dollar count is
  // taken for a percentage. The percent is computed here; dollars go where
  // magpie shows counts.
  const left = dollars(bal.quota);
  const spent = dollars(bal.used);
  const whole = dollars(bal.total);
  const usedPct = whole > 0 ? Math.min(100, Math.max(0, (spent / whole) * 100)) : 0;
  const remainingPct = Math.max(0, 100 - usedPct);

  return {
    user: meta(auth, "email") || bal.name || meta(auth, "username") || "",
    balance: `$${left.toFixed(2)}`,
    windows: [
      {
        name: "Balance",
        used: Math.round(usedPct * 10) / 10,
        remaining: Math.round(remainingPct * 10) / 10,
        amount: spent,
        limit: whole,
        unit: "usd",
        display: `$${left.toFixed(2)} / $${whole.toFixed(2)}`,
      },
    ],
  };
}

// A completed login and a confirmed reward are different results.
function checkinResult(checkedIn) {
  if (checkedIn === true) return { outcome: "claimed", message: "AgentRouter：站点确认本次登录签到成功，新增额度已到账" };
  if (checkedIn === false) return { outcome: "done", message: "AgentRouter：已完成登录，站点返回本次未新增签到额度（checked_in=false）" };
  return { outcome: "failed", message: "AgentRouter：登录成功但站点未返回有效签到标记，无法确认额度发放" };
}

// checkinOf claims the day's credit the only way this site grants one: by
// signing in. The site has no /api/user/checkin — that path falls through to
// New API's admin route /api/user/:id and answers every ordinary account
// "权限不足", the same as /api/user/foo would — and its front end says
// "签到成功，新增额度已到账" when a login response carries checked_in. So
// signing in *is* the check-in. GitHub-only accounts need a GitHub session;
// their site access token or site session cannot repeat the OAuth login.
//
// What comes back is `claimed` when this sign-in granted the day, and `done`
// when the site explicitly reports no new grant (not proof of an earlier one). A
// wrong password is the account's to fix and settles for the day; a site
// that is down is retried, as magpie retries any `failed`.
async function checkinOf(getAuth, provider, client) {
  const auth = await getAuth();
  if (!auth) return { outcome: "failed", message: "AgentRouter：尚未登录" };
  const r = await signIn(provider, auth);
  if (r.ok) await keepSession(client, auth, r);
  if (!r.ok) {
    if (r.why === "no-password") {
      return {
        outcome: "ineligible",
        message: "AgentRouter：签到就是登录一次，需要在账号里填站点用户名和密码（不是模型 API Key）",
      };
    }
    if (r.why === "bad-password") {
      return {
        outcome: "ineligible",
        message: `AgentRouter：站点拒绝了登录，请核对账号里的用户名和密码（站点返回「${r.message ?? r.why}」）`,
        signIn: "expired",
      };
    }
    if (r.blocked) {
      return { outcome: "failed", message: "AgentRouter：登录接口被站点验证码/防火墙拦截，稍后重试" };
    }
    return { outcome: "failed", message: `AgentRouter：登录失败（${r.why}）` };
  }
  return checkinResult(r.checkedIn);
}

// declaredModels is the models this plugin vouches for, in the shape magpie
// wants: a fresh object each time, because magpie edits what it is given.
function declaredModels() {
  const out = {};
  for (const [id, name] of Object.entries(DECLARED_MODELS)) out[id] = { ...MODEL_SHAPE, name };
  return out;
}

// modelsOf asks the vendor for the models this account has. It is the same
// list every agent sees, and the vendor keeps it current.
async function modelsOf(provider, { auth } = {}) {
  // The fallback is this plugin's own list, never the row's: the row may
  // still carry models a cached models.dev catalog gave it, and handing those
  // back would advertise models the site no longer serves.
  const fallback = declaredModels();
  if (!auth) return fallback;
  const key = apiKey(auth);
  if (!key) return fallback;
  try {
    const res = await fetch(`${apiBase(provider, auth)}/models`, {
      headers: applyHeaders(new Headers(), { ...headersOf(provider, auth), Authorization: `Bearer ${key}` }),
      signal: withTimeout(REQUEST_TIMEOUT),
    });
    const { json } = await jsonOrText(res);
    if (!res.ok || !Array.isArray(json?.data)) return fallback;
    const out = {};
    for (const m of json.data) {
      if (!m?.id) continue;
      out[m.id] = {
        ...MODEL_SHAPE,
        name: m.name ?? m.display_name ?? m.id,
        limit: {
          context: Number(m.context_length ?? m.context_window ?? MODEL_SHAPE.limit.context) || MODEL_SHAPE.limit.context,
          output: Number(m.max_output_tokens ?? m.max_tokens ?? MODEL_SHAPE.limit.output) || MODEL_SHAPE.limit.output,
        },
        ...(m.supported_endpoint_types?.length ? { endpoints: m.supported_endpoint_types } : {}),
        // The vendor says "openai" for what is its Responses API; the gateway
        // reads that as the protocol the model speaks.
        responses: true,
      };
    }
    return Object.keys(out).length ? out : fallback;
  } catch {
    return fallback;
  }
}

export const AgentRouterAuthPlugin = async (input) => {
  // The host hands over its reader for the provider's switches; an older one
  // has none, and the Codex headers stay on there (README, "为什么需要自定义
  // 请求头"). Reading it through a closure keeps headersOf's own signature —
  // provider and account — which every caller already passes.
  codexHeaders = () => input?.magpie?.option?.(PROVIDER, "send-codex-headers") !== false;
  const portableResponses = () => input?.magpie?.option?.(PROVIDER, "portable-responses") !== false;
  const dropAzureState = () => input?.magpie?.option?.(PROVIDER, "drop-azure-state") === true;
  const textFilterEnabled = () => input?.magpie?.option?.(PROVIDER, "text-filter") !== false;
  return {
    // The provider before anyone signs in: the models the vendor serves, so the
    // row has something to show, and the shape each listed one takes.
    //
    // The vendor's models answer the Responses API only: a chat-completions
    // request is refused with "does not support /v1/chat/completions, please use
    // /v1/responses", whatever the key. So the provider speaks Responses, and
    // the gateway translates an agent's Chat or Anthropic request into it.
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER];
      if (!was) {
        cfg.provider[PROVIDER] = {
          name: "AgentRouter",
          npm: "@ai-sdk/openai",
          api: `${ENDPOINT}/v1`,
          models: declaredModels(),
        };
      } else if (typeof was.api === "string" && /agentrouter\.org/i.test(was.api)) {
        // The plugin now serves the China site only; move a provider made
        // against the old international endpoint over with it.
        was.api = `${ENDPOINT}/v1`;
      }
    },

    auth: {
      provider: PROVIDER,

      // One site account, two credentials derived from it: the password
      // signs in for the day's credit and the balance, and the model key is
      // read from the account's own /api/token list (never typed).
      methods: [
        {
          type: "api",
          keyless: true,
          label: "AgentRouter（站点账号）",
          prompts: [
            {
              type: "text",
              key: "username",
              message: "AgentRouter 站点用户名或邮箱",
              placeholder: "you@example.com",
              validate: value => String(value ?? "").trim() ? undefined : "请输入站点用户名或邮箱",
            },
            {
              type: "password",
              key: "password",
              message: "AgentRouter 站点密码（只存在本机，用于登录签到和读取模型 Key）",
              validate: value => String(value ?? "") ? undefined : "请输入站点密码",
            },
          ],
          // The API key is not typed: sign in with the site account, then
          // read the account's own model keys from /api/token and keep the
          // one with the most room. The host sees an authorize with prompts
          // and asks no key of its own.
          async authorize(inputs) {
            const site = "air";
            const username = String(inputs?.username ?? "").trim();
            const password = String(inputs?.password ?? "");
            if (!username || !password) return { type: "failed", error: "请输入站点用户名和密码" };
            const auth = {
              type: "api",
              key: "",
              metadata: { site, username, password },
            };
            let login;
            try {
              login = await signIn({}, auth);
            } catch {
              return { type: "failed", error: "站点登录请求失败或超时，请稍后重试" };
            }
            if (!login.ok) {
              if (login.why === "bad-password") return { type: "failed", error: `${login.message ?? login.why}（请核对站点用户名和密码）` };
              if (login.blocked) return { type: "failed", error: "登录接口被站点验证码/防火墙拦截，请稍后重试" };
              return { type: "failed", error: `站点登录失败：${login.message ?? login.why}` };
            }
            const found = await sessionModelKey({}, auth, login);
            if (found.kind !== "found") {
              const extra = found.kind === "missing"
                ? "。请先在站点「令牌」页创建一把启用的模型 Key"
                : found.kind === "no-session"
                  ? "。站点登录成功，但响应里没有会话 Cookie"
                  : "";
              return { type: "failed", error: `站点登录成功，但读取模型 Key 失败：${keyProblem(found.kind)}${extra}` };
            }
            return {
              type: "success",
              key: found.key,
              metadata: {
                site,
                username,
                email: username,
                password,
                ...(login.userId ? { userId: login.userId } : {}),
                ...(login.cookie ? { cookie: login.cookie } : {}),
              },
            };
          },
        },
      ],
      // Inline replay avoids resource-local item lookups when complete contents
      // are present. Server-only references and unknown kinds stay untouched.
      // Response normalization preserves successful bytes and never retries.
      async loader(getAuth, provider) {
        const auth = (await getAuth()) ?? {};
        const textFilter = textFilterEnabled() ? await loadTextFilter() : null;
        const base = apiBase(provider, auth);
        return {
          baseURL: base,
          apiKey: apiKey(auth) || "agentrouter",
          async fetch(input, init = {}) {
            const key = apiKey(auth);
            if (!usableModelKey(key)) {
              return Response.json({ error: {
                type: "invalid_request_error",
                code: "agentrouter_missing_api_key",
                message: "尚未配置模型 API Key，请重新登录 AgentRouter 获取账号下的模型 Key。",
              } }, { status: 400 });
            }
            const h = new Headers(input instanceof Request ? input.headers : undefined);
            new Headers(init.headers ?? {}).forEach((v, k) => h.set(k, v));
            applyHeaders(h, headersOf(provider, auth));
            if (key) h.set("Authorization", `Bearer ${key}`);
            const requestInit = { ...init, headers: h };
            const prepared = await prepareRequest(input, requestInit, {
              portableResponses: portableResponses(),
              stripNodeState: dropAzureState(),
              textFilter: textFilterEnabled() ? textFilter : null,
            });
            return explainResponse(await fetch(input, prepared));
          },
        };
      },

      usage: usageOf,
      checkin: (getAuth, provider) => checkinOf(getAuth, provider, input?.client),

      // Switches the user can turn on the provider's editor.
      options: [
        {
          key: "drop-azure-state",
          label: "去掉 Azure 后端绑定状态",
          labels: { zh: "去掉 Azure 后端绑定状态", en: "Drop Azure resource-bound state" },
          default: true,
          description:
            "AgentRouter 在多个 Azure OpenAI 资源间负载均衡；上一轮的 item id、reasoning/encrypted_content 和 previous_response_id 绑在创建它的资源上，换到另一个资源会报 “The requested item was created under a different Azure OpenAI resource”。开启后发送前移除这些绑定状态，保留消息内容、call_id 和工具参数；代价是隐藏思维链不再跨轮延续。",
          descriptions: {
            zh: "AgentRouter 在多个 Azure OpenAI 资源间负载均衡；上一轮的 item id、reasoning/encrypted_content 和 previous_response_id 绑在创建它的资源上，换到另一个资源会报 “The requested item was created under a different Azure OpenAI resource”。开启后发送前移除这些绑定状态，保留消息内容、call_id 和工具参数；代价是隐藏思维链不再跨轮延续。",
            en: "AgentRouter load-balances across Azure OpenAI resources; item ids, reasoning/encrypted_content and previous_response_id belong to the resource that minted them, and another resource refuses them with “The requested item was created under a different Azure OpenAI resource”. On, those resource-bound states are removed before sending while message content, call_id and tool arguments stay; hidden reasoning no longer carries across turns.",
          },
        },
        {
          key: "text-filter",
          label: "发送前过滤配置的词",
          labels: { zh: "发送前过滤配置的词", en: "Filter configured prose before sending" },
          default: true,
          description:
            "读取插件目录的 content-filter.local.json，只过滤你配置的词，不猜词；保留 Markdown 代码、工具数据和加密状态。改完规则需重新加载插件。",
          descriptions: {
            zh: "读取插件目录的 content-filter.local.json，只过滤你配置的词，不猜词；保留 Markdown 代码、工具数据和加密状态。改完规则需重新加载插件。",
            en: "Uses content-filter.local.json; no guessed terms. Preserves recognized Markdown code, tool data and encrypted state. Reload after editing rules.",
          },
        },
        {
          key: "portable-responses",
          label: "把完整的 Responses item 内联重放",
          labels: { zh: "把完整的 Responses item 内联重放", en: "Replay complete Responses items inline" },
          description:
            "只有在内容已内联时才去掉资源本地 ID；保留 call_id 和加密内容。只有引用、没有内联内容的历史仍需原资源。关闭只停用 ID 重放，不影响文字过滤。",
          descriptions: {
            zh: "只有在内容已内联时才去掉资源本地 ID；保留 call_id 和加密内容。只有引用、没有内联内容的历史仍需原资源。关闭只停用 ID 重放，不影响文字过滤。",
            en: "Remove resource-local IDs only when inline content is available; preserve call_id and encrypted content. Reference-only history still requires the original resource. Off disables ID replay only; text-filter is independent.",
          },
          default: true,
        },
        {
          key: "send-codex-headers",
          label: "发送 Codex 客户端 User-Agent",
          labels: { zh: "发送 Codex 客户端 User-Agent", en: "Send the Codex client User-Agent" },
          description:
            "AgentRouter 网关只应答它认识的客户端。开启时按 Codex CLI 发送 User-Agent；关闭时保留 Agent 自己的 User-Agent。高级 Headers 或账号请求头里设置的 User-Agent 始终优先。",
          descriptions: {
            zh: "AgentRouter 网关只应答它认识的客户端。开启时按 Codex CLI 发送 User-Agent；关闭时保留 Agent 自己的 User-Agent。高级 Headers 或账号请求头里设置的 User-Agent 始终优先。",
            en: "AgentRouter's gateway only answers clients it recognises. On, the Codex CLI User-Agent is sent; off, the agent's own User-Agent is kept. A User-Agent set in Advanced Headers or the account headers always wins.",
          },
          default: true,
        },
      ],
    },

    provider: {
      id: PROVIDER,
      models: modelsOf,
    },

    // A conversation's turns reach the vendor under one id, so its cache sees
    // them as one conversation.
    "chat.headers": async (input, output) => {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return;
      if (input.sessionID) output.headers["x-session-id"] = input.sessionID;
    },
  };
};

export default AgentRouterAuthPlugin;
export const _internal = {
  PROVIDER,
  SITES,
  DEFAULT_HEADERS,
  DECLARED_MODELS,
  parseHeaders,
  parseCookies,
  headersOf,
  applyHeaders,
  apiBase,
  siteBase,
  userHeaders,
  isURLish,
  declaredModels,
};

