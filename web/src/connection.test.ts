import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectionStore } from "./connection";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const KEY = "sk-live-abcdefghij";

test("the key is never written unless the user opts in to remembering it", () => {
  const storage = memoryStorage();
  const store = createConnectionStore(storage);
  store.save({ provider: "google", apiKey: KEY, remember: false });
  assert.deepEqual([...storage.data.values()], ["google"]); // provider only
  assert.ok(![...storage.data.values()].includes(KEY));
  assert.deepEqual(store.load(), { provider: "google", apiKey: "", remember: false });
});

test("opting in stores the key; opting out removes it again", () => {
  const storage = memoryStorage();
  const store = createConnectionStore(storage);
  store.save({ provider: "anthropic", apiKey: KEY, remember: true });
  assert.deepEqual(store.load(), { provider: "anthropic", apiKey: KEY, remember: true });

  store.save({ provider: "anthropic", apiKey: KEY, remember: false });
  assert.deepEqual(store.load(), { provider: "anthropic", apiKey: "", remember: false });
  assert.ok(![...storage.data.values()].includes(KEY));
});

test("forgetting the key (empty key) removes it even if remember was on", () => {
  const storage = memoryStorage();
  const store = createConnectionStore(storage);
  store.save({ provider: "anthropic", apiKey: KEY, remember: true });
  store.save({ provider: "anthropic", apiKey: "", remember: true });
  assert.equal(store.load().apiKey, "");
});

test("an unknown stored provider falls back to the default", () => {
  const storage = memoryStorage();
  storage.setItem("blabberledger.provider", "openai");
  assert.equal(createConnectionStore(storage).load().provider, "anthropic");
});

test("unavailable or throwing storage behaves as memory-only without crashing", () => {
  const none = createConnectionStore(null);
  none.save({ provider: "google", apiKey: KEY, remember: true });
  assert.deepEqual(none.load(), { provider: "anthropic", apiKey: "", remember: false });

  const boom = createConnectionStore({
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  });
  assert.doesNotThrow(() => boom.save({ provider: "google", apiKey: KEY, remember: true }));
  assert.equal(boom.load().apiKey, "");
});
