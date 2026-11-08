import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, toJournal, toTsv } from "./export";
import { applyCategoryList } from "./categories";
import { needsReview, ParseRequestSchema, type LedgerEntry } from "./schema";

const base: LedgerEntry = {
  date: "2026-11-04",
  type: "expense",
  amount: 12.5,
  currency: "USD",
  payee: "Costco",
  category: "groceries",
  memo: "paper towels, eggs",
  confidence: 0.95,
  uncertainFields: [],
};

test("csv quotes commas and guards formula injection", () => {
  const csv = toCsv([{ ...base, payee: "=HYPERLINK(1)", memo: 'said "hi", left' }]);
  const row = csv.split("\n")[1] ?? "";
  assert.ok(row.includes("'=HYPERLINK(1)"));
  assert.ok(row.includes('"said ""hi"", left"'));
});

test("journal signs income negative and keeps undated rows visible", () => {
  const journal = toJournal([{ ...base, type: "income", date: null }]);
  assert.match(journal, /DATE UNKNOWN/);
  assert.match(journal, /income:groceries\s+-12\.50 USD/);
});

test("review routing", () => {
  assert.equal(needsReview(base), false);
  assert.equal(needsReview({ ...base, confidence: 0.5 }), true);
  assert.equal(needsReview({ ...base, uncertainFields: ["amount"] }), true);
  assert.equal(needsReview({ ...base, date: null }), true);
});

test("request validation rejects empty text and bad dates", () => {
  const ok = { text: "coffee 4.50", today: "2026-11-05", apiKey: "sk-test-1234567890" };
  assert.ok(ParseRequestSchema.safeParse(ok).success);
  assert.ok(!ParseRequestSchema.safeParse({ ...ok, text: "   " }).success);
  assert.ok(!ParseRequestSchema.safeParse({ ...ok, today: "11/05/2026" }).success);
});

test("tsv has one row per entry, no stray tabs, and guards formula injection", () => {
  const tsv = toTsv([{ ...base, payee: "@SUM(A1)", memo: "line one\tline two\nline three" }]);
  const [header, row] = tsv.split("\n");
  assert.equal(header, "date\ttype\tamount\tcurrency\tpayee\tcategory\tmemo");
  const cells = (row ?? "").split("\t");
  assert.equal(cells.length, 7);
  assert.equal(cells[4], "'@SUM(A1)");
  assert.equal(cells[6], "line one line two line three");
  assert.equal(tsv.split("\n").length, 3); // header, row, trailing newline
});

test("request validation accepts a category list and rejects oversized ones", () => {
  const ok = { text: "coffee 4.50", today: "2026-11-05", apiKey: "sk-test-1234567890" };
  assert.ok(ParseRequestSchema.safeParse({ ...ok, categories: ["Groceries", "Fun"] }).success);
  assert.ok(!ParseRequestSchema.safeParse({ ...ok, categories: [""] }).success);
  assert.ok(!ParseRequestSchema.safeParse({ ...ok, categories: ["x".repeat(41)] }).success);
  assert.ok(!ParseRequestSchema.safeParse({ ...ok, categories: Array.from({ length: 31 }, (_, i) => `c${i}`) }).success);
});

test("category list: no list means no change", () => {
  assert.equal(applyCategoryList(base, undefined), base);
  assert.equal(applyCategoryList(base, []), base);
});

test("category list: matches snap to the user's own spelling", () => {
  const out = applyCategoryList(base, ["Dining", "Groceries"]);
  assert.equal(out.category, "Groceries");
  assert.deepEqual(out.uncertainFields, []);
  // already exact: same object back
  const exact = { ...base, category: "Groceries" };
  assert.equal(applyCategoryList(exact, ["Groceries"]), exact);
});

test("category list: off-list categories are flagged once, not rewritten", () => {
  const out = applyCategoryList({ ...base, category: "pets" }, ["Dining", "Groceries"]);
  assert.equal(out.category, "pets");
  assert.deepEqual(out.uncertainFields, ["category"]);
  assert.equal(needsReview(out), true);
  const again = applyCategoryList(out, ["Dining", "Groceries"]);
  assert.deepEqual(again.uncertainFields, ["category"]);
});
