// Node entry point for local development (and hosts that run a long-lived Node process).
import { serve } from "@hono/node-server";
import { app } from "./app";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`BabbleLedger API on :${port}`));
