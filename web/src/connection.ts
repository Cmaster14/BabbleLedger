import { PROVIDERS, type Provider } from "@babbleledger/shared";

/**
 * The user's provider choice and API key.
 *
 * The key lives in memory only. It is written to browser storage solely when
 * the user ticks "remember on this device", and removed the moment they
 * untick it or press "forget".
 */
export interface Connection {
  provider: Provider;
  apiKey: string;
  remember: boolean;
}

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PROVIDER_KEY = "babbleledger.provider";
const API_KEY = "babbleledger.apiKey";

export function createConnectionStore(storage: KV | null) {
  const safe = <T>(fn: (s: KV) => T, fallback: T): T => {
    if (!storage) return fallback;
    try {
      return fn(storage);
    } catch {
      return fallback; // storage blocked or full: behave as if memory-only
    }
  };

  function load(): Connection {
    const savedProvider = safe((s) => s.getItem(PROVIDER_KEY), null);
    const provider = PROVIDERS.find((p) => p === savedProvider) ?? "anthropic";
    const apiKey = safe((s) => s.getItem(API_KEY), null) ?? "";
    return { provider, apiKey, remember: apiKey !== "" };
  }

  /** Persist the connection. The key is only stored when `remember` is true. */
  function save(conn: Connection): void {
    safe((s) => s.setItem(PROVIDER_KEY, conn.provider), undefined);
    if (conn.remember && conn.apiKey) safe((s) => s.setItem(API_KEY, conn.apiKey), undefined);
    else safe((s) => s.removeItem(API_KEY), undefined);
  }

  return { load, save };
}

export function browserConnectionStore() {
  let storage: Storage | null = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    storage = null;
  }
  return createConnectionStore(storage);
}
