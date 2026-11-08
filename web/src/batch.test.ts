import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkLines, chunkText } from "./batch";
import type { NoteLine } from "./state";

const mk = (texts: string[]): NoteLine[] => texts.map((text, i) => ({ id: `l${i}`, text, posted: false }));

test("no lines, no requests", () => {
  assert.deepEqual(chunkLines([]), []);
});

test("small notebooks go in one request, in order", () => {
  const chunks = chunkLines(mk(["a", "b", "c"]));
  assert.equal(chunks.length, 1);
  assert.equal(chunkText(chunks[0]!), "a\nb\nc");
});

test("splits by line count", () => {
  const chunks = chunkLines(mk(Array.from({ length: 7 }, (_, i) => `n${i}`)), { maxChars: 10_000, maxLines: 3 });
  assert.deepEqual(chunks.map((c) => c.length), [3, 3, 1]);
  assert.deepEqual(chunks.flat().map((l) => l.id), ["l0", "l1", "l2", "l3", "l4", "l5", "l6"]);
});

test("splits by character budget", () => {
  const chunks = chunkLines(mk(["x".repeat(50), "y".repeat(50), "z".repeat(50)]), { maxChars: 110, maxLines: 25 });
  assert.deepEqual(chunks.map((c) => c.length), [2, 1]);
});

test("a single oversized line gets its own request instead of being truncated", () => {
  const chunks = chunkLines(mk(["short", "q".repeat(500), "tail"]), { maxChars: 100, maxLines: 25 });
  assert.deepEqual(chunks.map((c) => c.length), [1, 1, 1]);
  assert.equal(chunks[1]![0]!.text.length, 500);
});

test("default limits keep every chunk under the API's 8000-char cap", () => {
  const lines = mk(Array.from({ length: 200 }, () => "w".repeat(180)));
  for (const chunk of chunkLines(lines)) {
    assert.ok(chunkText(chunk).length <= 8000);
    assert.ok(chunk.length <= 25);
  }
});
