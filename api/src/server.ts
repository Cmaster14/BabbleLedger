import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { ParseRequestSchema } from "@blabberledger/shared";
import { parseNotes } from "./parse";

const app = new Hono();

// CORS: set ALLOWED_ORIGIN to the deployed front-end origin(s), comma-separated.
// Defaults to local dev.
const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);
app.use("*", cors({ origin: allowedOrigins, allowMethods: ["POST", "OPTIONS"] }));

// Tiny in-memory rate limit per IP so the endpoint can't be used as an open proxy.
// Fine for a single instance; swap for a shared store if you scale out.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
const hits = new Map<string, number[]>();

app.use("/parse", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
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

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`BlabberLedger API on :${port}`));

export default app;
