# BlabberLedger

Jot down expense notes in plain English, get structured rows back, review anything uncertain, export. Local-first: no accounts, no server-side ledgers.

## Layout

```
shared/   Zod schema, review routing, category enforcement, CSV / TSV / hledger-journal export, tests
api/      Hono service with one endpoint: POST /parse (stateless)
web/      Vite + TypeScript front end (the ledger-book UI), talks to /parse
```

`web` and `api` both import `@blabberledger/shared`, so the schema, review rules and export formats exist in exactly one place.

## Run locally

```bash
npm install
cp api/.env.example api/.env     # optional; defaults work for local dev
npm run dev:api                  # http://localhost:8787
npm run dev:web                  # http://localhost:5173
```

Open the web app, expand **Connection**, paste your own Anthropic or Google API key, and post a few notes.

```bash
npm test                         # shared + web unit tests
npm run typecheck                # all three packages
npm run build:web                # production build into web/dist
```

## How the app behaves

- **Notebook → ledger.** Lines you add are posted in batches. Only lines not yet posted are sent, and new rows are appended, so edits you made to earlier rows are never overwritten. Posted lines stay visible, dimmed.
- **Review.** Rows the model wasn't sure about (confidence below 0.8, any uncertain field, or no date) are highlighted cell by cell. Fix a highlighted cell, or press **Confirm**. A row counts as reviewed once nothing flagged is left. Exporting with unreviewed rows asks first.
- **Editing.** Cells are editable and validated (real calendar date, positive amount, 3-letter currency, `expense`/`income`). Invalid edits revert with an explanation.
- **Expected categories (optional).** If you list categories, the model is told to stay inside them and the server enforces it afterwards: matches snap to your spelling, anything off-list is flagged for review.
- **Not transactions.** Text the model decides isn't a transaction is shown in a "Not recognised" box instead of being dropped.
- **Storage.** Notebook, ledger and categories live in this browser's IndexedDB. The API key lives in memory only, unless **Remember on this device** is ticked.
- **Export.** CSV (UTF-8 with BOM for Excel), TSV, JSON, and an hledger-style journal. CSV/TSV neutralise spreadsheet formula injection.

## POST /parse

```json
{
  "text": "coffee 4.50 yesterday, costco 82.10 groceries",
  "today": "2026-11-05",
  "provider": "anthropic",
  "apiKey": "<user's own key, used for this request only>",
  "categories": ["Groceries", "Dining"],
  "model": "optional override"
}
```

`categories` and `model` are optional. Returns `{ entries: [...], unparsed: [...] }`. Each entry carries `confidence`, `uncertainFields`, and a server-computed `needsReview` flag. Errors: `invalid_request` (400), `bad_key` (401), `provider_rate_limited` / `rate_limited` (429), `too_large` (413), `unparseable` (422), `upstream_error` (502).

## Key handling

- The browser sends the user's key with each request; the server builds a provider client per call and never stores or logs keys or note text (verified: the only thing logged on failure is the error class and status).
- The key stays in memory by default. It is persisted in `localStorage` only behind the explicit "remember on this device" opt-in, and removed on untick or "Forget key".
- A notice sits next to the input: notes are sent to an LLM provider, so sensitive information shouldn't be entered.

## Deploy

**API.** Any Node host works. Set `ALLOWED_ORIGIN` to the front end's origin (comma-separated for several, no path), e.g. `https://cmaster14.github.io`.

**Web (GitHub Pages).** `.github/workflows/pages.yml` builds `web/` and deploys it.

1. Repo **Settings → Pages → Source: GitHub Actions** (the old root `index.html` no longer exists, so the branch-based Pages setup stops working once this lands).
2. Add a repository **variable** `API_URL` with the deployed API address.
3. Push to `main`.

`.github/workflows/ci.yml` runs typecheck, tests and a build on every push and pull request.

## Notes

- Uses AI SDK `generateText` with `Output.object(...)`. `generateObject` is deprecated in the current release.
- Default model is `claude-haiku-5-5` (cheap for short parsing, runs on the user's key). Override per request or change `DEFAULT_MODELS` in `api/src/parse.ts`. `temperature` is only sent for Google, because the Anthropic model rejects it.
- Rate limiting is in-memory per IP, fine for a single free-tier instance. It keys on `x-forwarded-for`, so only trust it behind a proxy that sets that header.
- **Not yet run against a real provider key.** The whole stack, including the UI, has been exercised end to end against a fake provider endpoint, which proves the wiring but says nothing about parse quality. First thing to do: run a dozen messy notes through a real key and tune `SYSTEM` in `api/src/parse.ts`.

## Deploying the API to Cloudflare Workers

`api/src/app.ts` holds the Hono app; `server.ts` is the Node entry for local runs and `worker.ts` is the Workers entry.

- Connect the repo in Cloudflare (Workers & Pages -> Create -> Import a repository). Leave the root directory at the repo root.
- Build command: none. Deploy command: `npx wrangler deploy --config api/wrangler.toml`.
- Set `ALLOWED_ORIGIN` in `api/wrangler.toml` (or the Worker's Variables) to your Pages origin, e.g. `https://cmaster14.github.io`.
- Then set the repo Actions variable `API_URL` to the Worker's URL and re-run "Deploy web".
- The in-memory rate limit is per isolate, so add a Cloudflare rate-limiting rule for a real cap.
