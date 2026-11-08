import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, localToday, postParse, type ParseCall } from "./api";

const SECRET = "sk-ant-super-secret-1234567890";

const call = (over: Partial<ParseCall> = {}): ParseCall => ({
  baseUrl: "http://api.test/",
  provider: "anthropic",
  apiKey: SECRET,
  text: "coffee 4.50",
  today: "2026-11-06",
  categories: [],
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function failure(c: ParseCall): Promise<ApiError> {
  try {
    await postParse(c);
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected postParse to throw");
}

test("posts the documented body and returns the parsed result", async () => {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return json({ entries: [], unparsed: ["hi"] });
  };
  const res = await postParse(call({ fetchImpl }));
  assert.deepEqual(res, { entries: [], unparsed: ["hi"] });
  assert.equal(seen?.url, "http://api.test/parse");
  assert.deepEqual(seen?.body, {
    text: "coffee 4.50",
    today: "2026-11-06",
    provider: "anthropic",
    apiKey: SECRET,
  });
});

test("sends categories only when the user defined some", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json({ entries: [], unparsed: [] });
  };
  await postParse(call({ fetchImpl, categories: ["Groceries", "Fun"] }));
  await postParse(call({ fetchImpl, categories: [] }));
  assert.deepEqual(bodies[0]?.categories, ["Groceries", "Fun"]);
  assert.equal("categories" in (bodies[1] ?? {}), false);
});

test("maps the API's error codes to plain-language messages", async () => {
  const cases: [number, string, RegExp][] = [
    [401, "bad_key", /rejected the API key/i],
    [429, "provider_rate_limited", /rate limiting this key/i],
    [429, "rate_limited", /too many requests/i],
    [413, "too_large", /too large/i],
    [422, "unparseable", /couldn't be read/i],
    [400, "invalid_request", /too long/i],
    [502, "upstream_error", /try again/i],
  ];
  for (const [status, code, pattern] of cases) {
    const err = await failure(call({ fetchImpl: async () => json({ error: code }, status) }));
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    assert.match(err.message, pattern);
  }
});

test("unknown errors fall back to the server message, then a generic one", async () => {
  const a = await failure(call({ fetchImpl: async () => json({ error: "weird", message: "custom text" }, 500) }));
  assert.equal(a.message, "custom text");
  const b = await failure(call({ fetchImpl: async () => new Response("<html>oops</html>", { status: 503 }) }));
  assert.equal(b.code, "http_error");
  assert.match(b.message, /503/);
});

test("network failures and timeouts become friendly errors that never contain the key", async () => {
  const down = await failure(call({ fetchImpl: async () => { throw new TypeError(`fetch failed for key ${SECRET}`); } }));
  assert.equal(down.code, "network");
  assert.ok(!down.message.includes(SECRET));

  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const slow = await failure(call({ fetchImpl: hang, timeoutMs: 20 }));
  assert.equal(slow.code, "timeout");
});

test("a 200 with the wrong shape is rejected", async () => {
  const err = await failure(call({ fetchImpl: async () => json({ nope: true }) }));
  assert.equal(err.code, "bad_response");
});

test("a build without an API address says so instead of calling fetch", async () => {
  let called = false;
  const err = await failure(call({ baseUrl: "", fetchImpl: async () => { called = true; return json({}); } }));
  assert.equal(err.code, "no_api_url");
  assert.equal(called, false);
});

test("localToday uses the local calendar date, not UTC", () => {
  assert.equal(localToday(new Date(2026, 10, 6, 23, 59)), "2026-11-06");
  assert.equal(localToday(new Date(2026, 0, 2, 0, 1)), "2026-01-02");
});
