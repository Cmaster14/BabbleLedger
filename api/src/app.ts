import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { ParseRequestSchema } from "@blabberledger/shared";
import { parseNotes } from "./parse";

type Bindings = { ALLOWED_ORIGIN?: string };

export const app = new Hono<{ Bindings: Bindings }>();

// CORS: set ALLOWED_ORIGIN to the deployed front-end origin(s), comma-separated.
// Defaults to local dev.
// Read per request: Workers supplies vars on c.env, Node on process.env.
function allowedOrigins(env: Bindings | undefined): string[] {
  const raw = env?.ALLOWED_ORIGIN ?? (typeof process !== "undefined" ? process.env.ALLOWED_ORIGIN : undefined) ?? "http://localhost:5173";
  return raw.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
}
app.use("*", (c, next) =>
  cors({
    origin: (origin) => (allowedOrigins(c.env).includes(origin) ? origin : null),
    allowMethods: ["POST", "OPTIONS"],
  })(c, next),
);

// Tiny in-memory rate limit per IP so the endpoint can't be used as an open proxy.
// Per-instance only (on Workers each isolate counts separately), so a soft guard: add a
// Cloudflare rate-limiting rule in front for a real cap.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const hits = new Map<string, number[]>();

app.use("/parse", async (c, next) => {
  const ip =
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    return c.json({ error: "rate_limited", message: "Too many requests. Try again shortly." }, 429);
  }
  recent.push(now);
  hits.set(ip, recent);
  await next();
});

app.use("/parse", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }));

app.get("/health", (c) => c.json({ ok: true }));

app.post("/parse", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ParseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", issues: parsed.error.issues.map((i) => i.path.join(".")) }, 400);
  }

  try {
    return c.json(await parseNotes(parsed.data));
  } catch (err) {
    // Never echo request bodies or keys. Log only the error class/message.
    const name = err instanceof Error ? err.name : "Error";
    const status = (err as { statusCode?: number }).statusCode;
    console.error(`parse failed: ${name}${status ? ` (${status})` : ""}`);
    if (status === 401 || status === 403) {
      return c.json({ error: "bad_key", message: "The provider rejected the API key." }, 401);
    }
    if (status === 429) {
      return c.json({ error: "provider_rate_limited", message: "The provider is rate limiting this key." }, 429);
    }
    if (name === "AI_NoObjectGeneratedError" || name === "NoObjectGeneratedError" || name === "NoOutputGeneratedError") {
      return c.json({ error: "unparseable", message: "The model's reply couldn't be read. Try rewording the note." }, 422);
    }
    return c.json({ error: "upstream_error", message: "Parsing failed. Please try again." }, 502);
  }
});

export default app;
