import {
  LedgerEntrySchema,
  MAX_CATEGORIES,
  MAX_CATEGORY_LENGTH,
  needsReview,
  type ParseResult,
  type ParsedEntry,
} from "@blabberledger/shared";

export const EDITABLE_FIELDS = ["date", "type", "amount", "currency", "payee", "category", "memo"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** One line of the notebook. `posted` lines have already been turned into ledger rows. */
export interface NoteLine {
  id: string;
  text: string;
  posted: boolean;
}

/** A ledger row plus the client-side review decision. */
export type Row = ParsedEntry & { id: string; reviewed: boolean };

export interface AppState {
  lines: NoteLine[];
  rows: Row[];
  categories: string[];
  /** Pieces of input the model said were not transactions. */
  skipped: string[];
}

export type Result = { ok: true; state: AppState } | { ok: false; error: string };

export const emptyState = (): AppState => ({ lines: [], rows: [], categories: [], skipped: [] });

let counter = 0;
export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

/** Split a block of text into individual notebook lines. */
export function splitIntoLines(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function addLines(state: AppState, texts: string[]): AppState {
  const fresh = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text): NoteLine => ({ id: newId(), text, posted: false }));
  return fresh.length ? { ...state, lines: [...state.lines, ...fresh] } : state;
}

export function pendingLines(state: AppState): NoteLine[] {
  return state.lines.filter((l) => !l.posted);
}

/** Append a parse result to the ledger and mark the lines it came from as posted. */
export function applyBatch(state: AppState, lineIds: readonly string[], result: ParseResult): AppState {
  const ids = new Set(lineIds);
  const newRows = result.entries.map((e): Row => ({ ...e, id: newId(), reviewed: false }));
  const skipped = result.unparsed.map((s) => s.trim()).filter(Boolean);
  return {
    ...state,
    lines: state.lines.map((l) => (ids.has(l.id) ? { ...l, posted: true } : l)),
    rows: [...state.rows, ...newRows],
    skipped: [...state.skipped, ...skipped],
  };
}

// ---- review -----------------------------------------------------------------

export function isRowPending(row: Row): boolean {
  return !row.reviewed && needsReview(row);
}

export function pendingReviewCount(state: AppState): number {
  return state.rows.filter(isRowPending).length;
}

/** Should this cell be highlighted as a guess the user needs to check? */
export function fieldFlagged(row: Row, field: EditableField): boolean {
  if (!isRowPending(row)) return false;
  if (field === "date" && row.date === null) return true;
  return (row.uncertainFields as readonly string[]).includes(field);
}

// ---- editing ----------------------------------------------------------------

type Parsed = { ok: true; value: string | number | null } | { ok: false; error: string };

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseField(field: EditableField, raw: string): Parsed {
  const text = raw.replace(/\s+/g, " ").trim();
  switch (field) {
    case "date":
      if (text === "") return { ok: true, value: null };
      return isRealDate(text) ? { ok: true, value: text } : { ok: false, error: "Date must be a real date as YYYY-MM-DD." };
    case "type": {
      const t = text.toLowerCase();
      return t === "expense" || t === "income"
        ? { ok: true, value: t }
        : { ok: false, error: "Type must be “expense” or “income”." };
    }
    case "amount": {
      const n = Number(text.replace(/[$,\s]/g, ""));
      return Number.isFinite(n) && n > 0
        ? { ok: true, value: Math.round(n * 100) / 100 }
        : { ok: false, error: "Amount must be a positive number. Use “type” for direction." };
    }
    case "currency":
      return /^[A-Za-z]{3}$/.test(text)
        ? { ok: true, value: text.toUpperCase() }
        : { ok: false, error: "Currency must be a 3-letter code such as USD." };
    case "payee":
    case "category":
      return text ? { ok: true, value: text } : { ok: false, error: `${field[0]!.toUpperCase()}${field.slice(1)} can’t be empty.` };
    case "memo":
      return { ok: true, value: text };
  }
}

/**
 * Apply a user edit. Editing a flagged field clears that flag; once nothing
 * flagged is left (and the date is filled in) the row counts as reviewed.
 * An edit that changes nothing is not a review.
 */
export function editCell(state: AppState, rowId: string, field: EditableField, raw: string): Result {
  const index = state.rows.findIndex((r) => r.id === rowId);
  const row = state.rows[index];
  if (!row) return { ok: false, error: "That row no longer exists." };

  const parsed = parseField(field, raw);
  if (!parsed.ok) return parsed;
  if (parsed.value === row[field]) return { ok: true, state };

  const remaining = row.uncertainFields.filter((f) => f !== field);
  const next = Object.assign({}, row, { [field]: parsed.value, uncertainFields: remaining }) as Row;
  next.reviewed = row.reviewed || (remaining.length === 0 && next.date !== null);

  return { ok: true, state: { ...state, rows: state.rows.map((r, i) => (i === index ? next : r)) } };
}

export function confirmRow(state: AppState, rowId: string): AppState {
  return { ...state, rows: state.rows.map((r) => (r.id === rowId ? { ...r, reviewed: true } : r)) };
}

export function deleteRow(state: AppState, rowId: string): AppState {
  return { ...state, rows: state.rows.filter((r) => r.id !== rowId) };
}

export function clearNotebook(state: AppState): AppState {
  return { ...state, lines: [] };
}

export function clearLedger(state: AppState): AppState {
  return { ...state, rows: [], skipped: [] };
}

export function dismissSkipped(state: AppState): AppState {
  return { ...state, skipped: [] };
}

// ---- categories -------------------------------------------------------------

export function addCategory(state: AppState, raw: string): Result {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: true, state };
  if (name.length > MAX_CATEGORY_LENGTH) return { ok: false, error: `Categories can be up to ${MAX_CATEGORY_LENGTH} characters.` };
  if (state.categories.some((c) => c.toLowerCase() === name.toLowerCase())) return { ok: true, state };
  if (state.categories.length >= MAX_CATEGORIES) return { ok: false, error: `You can list up to ${MAX_CATEGORIES} categories.` };
  return { ok: true, state: { ...state, categories: [...state.categories, name] } };
}

export function removeCategory(state: AppState, index: number): AppState {
  return { ...state, categories: state.categories.filter((_, i) => i !== index) };
}

// ---- export -----------------------------------------------------------------

/** The seven ledger columns only; no review bookkeeping. */
export function ledgerRecords(rows: readonly Row[]) {
  return rows.map(({ date, type, amount, currency, payee, category, memo }) => ({
    date,
    type,
    amount,
    currency,
    payee,
    category,
    memo,
  }));
}

// ---- persistence ------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Rebuild state from whatever was in storage, dropping anything malformed. */
export function restoreState(raw: unknown): AppState {
  const state = emptyState();
  if (!isRecord(raw)) return state;

  if (Array.isArray(raw.lines)) {
    for (const l of raw.lines) {
      if (isRecord(l) && typeof l.text === "string" && l.text.trim()) {
        state.lines.push({ id: typeof l.id === "string" ? l.id : newId(), text: l.text, posted: l.posted === true });
      }
    }
  }
  if (Array.isArray(raw.rows)) {
    for (const r of raw.rows) {
      const parsed = LedgerEntrySchema.safeParse(r);
      if (!parsed.success || !isRecord(r)) continue;
      state.rows.push({
        ...parsed.data,
        needsReview: needsReview(parsed.data),
        id: typeof r.id === "string" ? r.id : newId(),
        reviewed: r.reviewed === true,
      });
    }
  }
  if (Array.isArray(raw.categories)) {
    for (const c of raw.categories) {
      if (typeof c === "string") {
        const added = addCategory(state, c);
        if (added.ok) state.categories = added.state.categories;
      }
    }
  }
  if (Array.isArray(raw.skipped)) {
    state.skipped = raw.skipped.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  }
  return state;
}
