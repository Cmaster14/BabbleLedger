import type { ParseResult, Provider } from "@blabberledger/shared";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Plain-language messages for the API's error codes (see the API README). */
const FRIENDLY: Record<string, string> = {
  bad_key: "Your provider rejected the API key. Check it under Connection.",
  provider_rate_limited: "Your provider is rate limiting this key. Wait a moment, then post again.",
  rate_limited: "Too many requests in a short time. Wait a minute, then post again.",
  too_large: "That batch of notes is too large to send. Try fewer or shorter lines.",
  unparseable: "The model's reply couldn't be read. Try rewording the notes and posting again.",
  invalid_request: "The service rejected the request. A note may be too long.",
  upstream_error: "Parsing failed on the provider's side. Please try again.",
};

export interface ParseCall {
  baseUrl: string;
  provider: Provider;
  apiKey: string;
  text: string;
  /** Local date, YYYY-MM-DD. */
  today: string;
  categories: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Local (not UTC) calendar date, so "yesterday" resolves in the user's timezone. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export async function postParse(call: ParseCall): Promise<ParseResult> {
  const base = call.baseUrl.replace(/\/+$/, "");
  if (!base) throw new ApiError("no_api_url", "This build has no API address configured (VITE_API_URL).");

  const doFetch = call.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? 60_000);

  try {
    let res: Response;
    try {
      res = await doFetch(`${base}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: call.text,
          today: call.today,
          provider: call.provider,
          apiKey: call.apiKey,
          ...(call.categories.length ? { categories: call.categories } : {}),
        }),
        signal: controller.signal,
      });
    } catch {
      // Deliberately generic: never put request details (the key) into an error.
      if (controller.signal.aborted) throw new ApiError("timeout", "The service took too long to respond. Try again.");
      throw new ApiError("network", `Couldn't reach the BlabberLedger service at ${base}. Is it running?`);
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body: handled below */
    }

    if (!res.ok) {
      const code = isRecord(data) && typeof data.error === "string" ? data.error : "http_error";
      const serverMessage = isRecord(data) && typeof data.message === "string" ? data.message : undefined;
      throw new ApiError(code, FRIENDLY[code] ?? serverMessage ?? `Request failed (${res.status}).`, res.status);
    }

    if (!isRecord(data) || !Array.isArray(data.entries) || !Array.isArray(data.unparsed)) {
      throw new ApiError("bad_response", "The service returned something unexpected.", res.status);
    }
    return data as unknown as ParseResult;
  } finally {
    clearTimeout(timer);
  }
}
