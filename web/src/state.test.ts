import { test } from "node:test";
import assert from "node:assert/strict";
import type { ParsedEntry } from "@blabberledger/shared";
import {
  addCategory,
  addLines,
  applyBatch,
  clearLedger,
  clearNotebook,
  confirmRow,
  deleteRow,
  editCell,
  emptyState,
  fieldFlagged,
  isRowPending,
  ledgerRecords,
  parseField,
  pendingLines,
  pendingReviewCount,
  removeCategory,
  restoreState,
  splitIntoLines,
  type AppState,
  type Row,
} from "./state";

const clean: ParsedEntry = {
  date: "2026-11-05",
  type: "expense",
  amount: 4.5,
  currency: "USD",
  payee: "Starbucks",
  category: "dining",
  memo: "",
  confidence: 0.95,
  uncertainFields: [],
  needsReview: false,
};

const shaky: ParsedEntry = {
  ...clean,
  payee: "Costco",
  amount: 82.1,
  confidence: 0.6,
  uncertainFields: ["amount", "category"],
  needsReview: true,
};

/** State with two notebook lines already posted into a clean row and a shaky row. */
function posted(): { state: AppState; cleanRow: Row; shakyRow: Row } {
  let state = addLines(emptyState(), ["coffee 4.50 yesterday", "costco about 82"]);
  state = applyBatch(
    state,
    state.lines.map((l) => l.id),
    { entries: [clean, shaky], unparsed: [] },
  );
  const [cleanRow, shakyRow] = state.rows as [Row, Row];
  return { state, cleanRow, shakyRow };
}

test("splitIntoLines trims and drops blanks", () => {
  assert.deepEqual(splitIntoLines("  a \n\n b\r\n   \nc"), ["a", "b", "c"]);
  assert.deepEqual(splitIntoLines("   "), []);
});

test("addLines appends unposted lines and ignores empty input", () => {
  let s = addLines(emptyState(), ["one", "  ", "two"]);
  assert.deepEqual(s.lines.map((l) => [l.text, l.posted]), [["one", false], ["two", false]]);
  assert.equal(addLines(s, ["", " "]), s);
  s = addLines(s, ["three"]);
  assert.equal(pendingLines(s).length, 3);
});

test("applyBatch appends rows, marks only that batch's lines posted, and keeps skipped text", () => {
  let s = addLines(emptyState(), ["a", "b", "c"]);
  const [a, b] = s.lines as [AppState["lines"][number], AppState["lines"][number]];
  s = applyBatch(s, [a.id, b.id], { entries: [clean], unparsed: ["  weather was nice ", ""] });
  assert.deepEqual(s.lines.map((l) => l.posted), [true, true, false]);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0]?.reviewed, false);
  assert.deepEqual(s.skipped, ["weather was nice"]);
  assert.equal(pendingLines(s).length, 1);

  // a second batch appends rather than replacing (so manual edits survive)
  const c = s.lines[2]!;
  s = applyBatch(s, [c.id], { entries: [shaky], unparsed: [] });
  assert.equal(s.rows.length, 2);
});

test("review flags: only unreviewed, low-confidence or uncertain rows are pending", () => {
  const { state, cleanRow, shakyRow } = posted();
  assert.equal(isRowPending(cleanRow), false);
  assert.equal(isRowPending(shakyRow), true);
  assert.equal(pendingReviewCount(state), 1);
  assert.equal(fieldFlagged(shakyRow, "amount"), true);
  assert.equal(fieldFlagged(shakyRow, "category"), true);
  assert.equal(fieldFlagged(shakyRow, "payee"), false);
  assert.equal(fieldFlagged(cleanRow, "amount"), false);
});

test("a missing date is flagged even when the model didn't list it", () => {
  const row: Row = { ...clean, date: null, needsReview: true, id: "x", reviewed: false };
  assert.equal(fieldFlagged(row, "date"), true);
});

test("confirming a row clears its flags", () => {
  const { state, shakyRow } = posted();
  const next = confirmRow(state, shakyRow.id);
  assert.equal(pendingReviewCount(next), 0);
  assert.equal(fieldFlagged(next.rows[1]!, "amount"), false);
});

test("editing a flagged field clears that flag; the row is reviewed once none remain", () => {
  const { state, shakyRow } = posted();

  const first = editCell(state, shakyRow.id, "amount", "$82.10 ");
  assert.ok(first.ok);
  const afterFirst = first.ok ? first.state.rows[1]! : shakyRow;
  // value is unchanged (82.10 === 82.1) so that was not a review
  assert.equal(afterFirst.reviewed, false);
  assert.deepEqual(afterFirst.uncertainFields, ["amount", "category"]);

  const fixAmount = editCell(state, shakyRow.id, "amount", "$85");
  assert.ok(fixAmount.ok);
  const afterAmount = fixAmount.ok ? fixAmount.state.rows[1]! : shakyRow;
  assert.equal(afterAmount.amount, 85);
  assert.deepEqual(afterAmount.uncertainFields, ["category"]);
  assert.equal(afterAmount.reviewed, false);
  assert.equal(fieldFlagged(afterAmount, "amount"), false);
  assert.equal(fieldFlagged(afterAmount, "category"), true);

  const fixCategory = editCell(fixAmount.ok ? fixAmount.state : state, shakyRow.id, "category", "Groceries");
  assert.ok(fixCategory.ok);
  const done = fixCategory.ok ? fixCategory.state.rows[1]! : shakyRow;
  assert.deepEqual(done.uncertainFields, []);
  assert.equal(done.reviewed, true);
});

test("filling in a missing date resolves the row", () => {
  let state = addLines(emptyState(), ["lunch 12"]);
  state = applyBatch(state, [state.lines[0]!.id], { entries: [{ ...clean, date: null, needsReview: true }], unparsed: [] });
  const row = state.rows[0]!;
  assert.equal(isRowPending(row), true);
  const res = editCell(state, row.id, "date", "2026-11-03");
  assert.ok(res.ok);
  if (res.ok) assert.equal(isRowPending(res.state.rows[0]!), false);
});

test("an edit that changes nothing is not a review", () => {
  const { state, shakyRow } = posted();
  const res = editCell(state, shakyRow.id, "payee", "Costco");
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.state, state);
    assert.equal(isRowPending(res.state.rows[1]!), true);
  }
});

test("invalid edits are rejected and leave state untouched", () => {
  const { state, shakyRow } = posted();
  for (const [field, raw] of [
    ["amount", "free"],
    ["amount", "-5"],
    ["amount", "0"],
    ["date", "2026-02-30"],
    ["date", "11/05/2026"],
    ["type", "refund"],
    ["currency", "DOLLARS"],
    ["payee", "   "],
    ["category", ""],
  ] as const) {
    const res = editCell(state, shakyRow.id, field, raw);
    assert.equal(res.ok, false, `${field}=${raw} should be rejected`);
  }
  assert.equal(editCell(state, "nope", "memo", "x").ok, false);
});

test("field parsing normalises what it accepts", () => {
  assert.deepEqual(parseField("amount", "$1,234.567"), { ok: true, value: 1234.57 });
  assert.deepEqual(parseField("currency", "eur"), { ok: true, value: "EUR" });
  assert.deepEqual(parseField("type", " Income "), { ok: true, value: "income" });
  assert.deepEqual(parseField("date", ""), { ok: true, value: null });
  assert.deepEqual(parseField("date", "2028-02-29"), { ok: true, value: "2028-02-29" });
  assert.deepEqual(parseField("memo", "a \n b"), { ok: true, value: "a b" });
});

test("delete and clear operations scope correctly", () => {
  const { state, cleanRow } = posted();
  assert.equal(deleteRow(state, cleanRow.id).rows.length, 1);
  assert.equal(clearNotebook(state).lines.length, 0);
  assert.equal(clearNotebook(state).rows.length, 2); // clearing the notebook keeps the ledger
  const wiped = clearLedger({ ...state, skipped: ["x"] });
  assert.equal(wiped.rows.length, 0);
  assert.equal(wiped.skipped.length, 0);
  assert.equal(wiped.lines.length, 2);
});

test("categories: dedupe case-insensitively, enforce limits, remove by index", () => {
  let s = emptyState();
  for (const name of ["Groceries", "  fun  money ", "groceries"]) {
    const r = addCategory(s, name);
    assert.ok(r.ok);
    if (r.ok) s = r.state;
  }
  assert.deepEqual(s.categories, ["Groceries", "fun money"]);
  assert.equal(addCategory(s, "x".repeat(41)).ok, false);
  assert.deepEqual(removeCategory(s, 0).categories, ["fun money"]);

  let full = emptyState();
  for (let i = 0; i < 30; i++) {
    const r = addCategory(full, `c${i}`);
    if (r.ok) full = r.state;
  }
  assert.equal(full.categories.length, 30);
  assert.equal(addCategory(full, "one more").ok, false);
});

test("export records carry the seven ledger columns and no review bookkeeping", () => {
  const { state } = posted();
  const [first] = ledgerRecords(state.rows);
  assert.deepEqual(Object.keys(first ?? {}), ["date", "type", "amount", "currency", "payee", "category", "memo"]);
});

test("restoreState keeps good data and drops malformed entries", () => {
  const { state } = posted();
  const stored = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  (stored.rows as unknown[]).push({ date: "not-a-date", amount: -1 }, null, "junk");
  (stored.lines as unknown[]).push({ text: 42 }, { text: "  " });
  (stored.categories as unknown[]).push(7);
  const restored = restoreState(stored);
  assert.equal(restored.rows.length, 2);
  assert.equal(restored.lines.length, 2);
  assert.equal(restored.lines.every((l) => l.posted), true);
  assert.equal(restored.rows[1]?.reviewed, false);
  assert.deepEqual(restored.categories, []);

  for (const bad of [undefined, null, 5, "x", [], { rows: "no" }]) {
    assert.deepEqual(restoreState(bad), emptyState());
  }
});
