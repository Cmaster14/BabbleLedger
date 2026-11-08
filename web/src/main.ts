import "./style.css";
import { PROVIDERS, toCsv, toJournal, toTsv, type Provider } from "@babbleledger/shared";
import { ApiError, localToday, postParse } from "./api";
import { chunkLines, chunkText } from "./batch";
import { browserConnectionStore, type Connection } from "./connection";
import { loadSavedState, saveState } from "./storage";
import {
  EDITABLE_FIELDS,
  addCategory,
  addLines,
  applyBatch,
  clearLedger,
  clearNotebook,
  confirmRow,
  deleteRow,
  dismissSkipped,
  editCell,
  emptyState,
  fieldFlagged,
  isRowPending,
  ledgerRecords,
  pendingLines,
  pendingReviewCount,
  removeCategory,
  restoreState,
  splitIntoLines,
  type AppState,
  type EditableField,
  type Row,
} from "./state";

// In a production build the API address must be supplied (VITE_API_URL).
const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.DEV ? "http://localhost:8787" : "");

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const ui = {
  connToggle: el<HTMLButtonElement>("connToggleBtn"),
  connSection: el<HTMLDivElement>("connSection"),
  connBadge: el<HTMLSpanElement>("connBadge"),
  provider: el<HTMLSelectElement>("providerSelect"),
  apiKey: el<HTMLInputElement>("apiKeyInput"),
  remember: el<HTMLInputElement>("rememberKey"),
  forgetKey: el<HTMLButtonElement>("forgetKeyBtn"),
  catToggle: el<HTMLButtonElement>("catToggleBtn"),
  catSection: el<HTMLDivElement>("catSection"),
  catBadge: el<HTMLSpanElement>("catBadge"),
  catChips: el<HTMLDivElement>("catChips"),
  catInput: el<HTMLInputElement>("categoryInput"),
  catAdd: el<HTMLButtonElement>("catAddBtn"),
  lineInput: el<HTMLTextAreaElement>("lineInput"),
  add: el<HTMLButtonElement>("addBtn"),
  chatlog: el<HTMLDivElement>("chatlog"),
  clearNotebook: el<HTMLButtonElement>("clearNotebookBtn"),
  process: el<HTMLButtonElement>("processBtn"),
  status: el<HTMLDivElement>("status"),
  banner: el<HTMLDivElement>("reviewBanner"),
  table: el<HTMLTableElement>("ledgerTable"),
  head: el<HTMLTableRowElement>("ledgerHead"),
  body: el<HTMLTableSectionElement>("ledgerBody"),
  empty: el<HTMLDivElement>("emptyLedger"),
  skippedBox: el<HTMLDivElement>("skippedBox"),
  skippedList: el<HTMLUListElement>("skippedList"),
  dismissSkipped: el<HTMLButtonElement>("dismissSkippedBtn"),
  exportRow: el<HTMLDivElement>("exportRow"),
  exportCsv: el<HTMLButtonElement>("exportCsvBtn"),
  exportTsv: el<HTMLButtonElement>("exportTsvBtn"),
  exportJson: el<HTMLButtonElement>("exportJsonBtn"),
  exportJournal: el<HTMLButtonElement>("exportJournalBtn"),
  clearLedger: el<HTMLButtonElement>("clearLedgerBtn"),
};

let state: AppState = emptyState();
const connectionStore = browserConnectionStore();
let connection: Connection = connectionStore.load();
let busy = false;

// ---- persistence ------------------------------------------------------------

let saveTimer: number | undefined;
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveState(state), 250);
}

function setState(next: AppState): void {
  state = next;
  scheduleSave();
}

// ---- status -----------------------------------------------------------------

function setStatus(message: string, isError = false, spinner = false): void {
  ui.status.className = "status" + (isError ? " error" : "");
  ui.status.replaceChildren();
  if (spinner) {
    const dot = document.createElement("span");
    dot.className = "spinner";
    ui.status.appendChild(dot);
  }
  ui.status.appendChild(document.createTextNode(message));
}

// ---- collapsible panels -----------------------------------------------------

function wireToggle(button: HTMLButtonElement, section: HTMLElement): (open: boolean) => void {
  const setOpen = (open: boolean) => {
    section.style.display = open ? "block" : "none";
    button.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", () => setOpen(section.style.display !== "block"));
  return setOpen;
}
const setConnOpen = wireToggle(ui.connToggle, ui.connSection);
wireToggle(ui.catToggle, ui.catSection);

// ---- connection -------------------------------------------------------------

function renderConnection(): void {
  ui.provider.value = connection.provider;
  ui.apiKey.value = connection.apiKey;
  ui.remember.checked = connection.remember;
  ui.connBadge.style.display = connection.apiKey ? "inline-block" : "none";
}

function updateConnection(patch: Partial<Connection>): void {
  connection = { ...connection, ...patch };
  connectionStore.save(connection);
  ui.connBadge.style.display = connection.apiKey ? "inline-block" : "none";
}

ui.provider.addEventListener("change", () => {
  const chosen = PROVIDERS.find((p) => p === ui.provider.value);
  if (chosen) updateConnection({ provider: chosen as Provider });
});
ui.apiKey.addEventListener("input", () => updateConnection({ apiKey: ui.apiKey.value.trim() }));
ui.remember.addEventListener("change", () => updateConnection({ remember: ui.remember.checked }));
ui.forgetKey.addEventListener("click", () => {
  updateConnection({ apiKey: "", remember: false });
  renderConnection();
  setStatus("Key forgotten.", false);
});

// ---- notebook ---------------------------------------------------------------

function renderChatlog(): void {
  ui.chatlog.replaceChildren();
  state.lines.forEach((line, i) => {
    const div = document.createElement("div");
    div.className = "entry-line" + (line.posted ? " posted" : "");
    div.title = line.posted ? "Already posted to the ledger" : "Waiting to be posted";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = line.posted ? "✓" : `${i + 1}.`;
    const text = document.createElement("span");
    text.textContent = line.text;
    div.append(idx, text);
    ui.chatlog.appendChild(div);
  });
  ui.chatlog.scrollTop = ui.chatlog.scrollHeight;
}

function submitInput(): void {
  const parts = splitIntoLines(ui.lineInput.value);
  if (parts.length === 0) return;
  setState(addLines(state, parts));
  ui.lineInput.value = "";
  renderChatlog();
}

ui.add.addEventListener("click", submitInput);
ui.lineInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitInput();
  }
});
// A multi-line paste becomes several notebook lines instead of one blob.
ui.lineInput.addEventListener("paste", (e) => {
  const pasted = e.clipboardData?.getData("text") ?? "";
  const parts = splitIntoLines(pasted);
  if (parts.length > 1) {
    e.preventDefault();
    setState(addLines(state, parts));
    renderChatlog();
  }
});

ui.clearNotebook.addEventListener("click", () => {
  setState(clearNotebook(state));
  renderChatlog();
  setStatus("", false);
});

// ---- categories -------------------------------------------------------------

function renderCategories(): void {
  ui.catChips.replaceChildren();
  state.categories.forEach((name, i) => {
    const chip = document.createElement("span");
    chip.className = "cat-chip";
    const label = document.createElement("span");
    label.textContent = name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove category";
    remove.addEventListener("click", () => {
      setState(removeCategory(state, i));
      renderCategories();
    });
    chip.append(label, remove);
    ui.catChips.appendChild(chip);
  });
  ui.catBadge.style.display = state.categories.length ? "inline-block" : "none";
  ui.catBadge.textContent = String(state.categories.length);
}

function submitCategory(): void {
  const result = addCategory(state, ui.catInput.value);
  if (!result.ok) {
    setStatus(result.error, true);
    return;
  }
  ui.catInput.value = "";
  if (result.state !== state) {
    setState(result.state);
    renderCategories();
  }
}
ui.catAdd.addEventListener("click", submitCategory);
ui.catInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitCategory();
  }
});

// ---- ledger -----------------------------------------------------------------

const COLUMN_LABELS: Record<EditableField, string> = {
  date: "date",
  type: "type",
  amount: "amount",
  currency: "currency",
  payee: "payee",
  category: "category",
  memo: "memo",
};

function buildHead(): void {
  ui.head.replaceChildren();
  const cells: { label: string; cls?: string }[] = [
    { label: "#" },
    { label: "review" },
    ...EDITABLE_FIELDS.map((f) => ({ label: COLUMN_LABELS[f], cls: f === "amount" ? "num" : undefined })),
    { label: "" },
  ];
  for (const c of cells) {
    const th = document.createElement("th");
    th.textContent = c.label;
    if (c.cls) th.className = c.cls;
    ui.head.appendChild(th);
  }
}

function displayValue(row: Row, field: EditableField): string {
  switch (field) {
    case "date":
      return row.date ?? "";
    case "amount":
      return row.amount.toFixed(2);
    default:
      return String(row[field]);
  }
}

function findRow(id: string | undefined): Row | undefined {
  return id ? state.rows.find((r) => r.id === id) : undefined;
}

function renderBanner(): void {
  const n = pendingReviewCount(state);
  if (n === 0) {
    ui.banner.style.display = "none";
    return;
  }
  ui.banner.style.display = "block";
  ui.banner.textContent = `${n} ${n === 1 ? "row needs" : "rows need"} a look. Highlighted cells are guesses: fix them, or press Confirm if they’re right.`;
}

/** Update one row's flags in place (no re-render, so tabbing between cells keeps focus). */
function paintRow(tr: HTMLTableRowElement, row: Row): void {
  const pending = isRowPending(row);
  tr.classList.toggle("needs-review", pending);
  tr.querySelectorAll<HTMLTableCellElement>("td[data-field]").forEach((td) => {
    td.classList.toggle("flagged", fieldFlagged(row, td.dataset.field as EditableField));
  });
  const statusCell = tr.querySelector<HTMLTableCellElement>("td.status-cell");
  if (!statusCell) return;
  statusCell.replaceChildren();
  if (pending) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-confirm";
    btn.textContent = "Confirm";
    btn.title = "Mark this row as reviewed";
    btn.addEventListener("click", () => {
      setState(confirmRow(state, row.id));
      const updated = findRow(row.id);
      if (updated) paintRow(tr, updated);
      renderBanner();
    });
    statusCell.appendChild(btn);
  } else {
    const ok = document.createElement("span");
    ok.className = "stamp-ok";
    ok.textContent = "✓";
    ok.title = "Reviewed";
    statusCell.appendChild(ok);
  }
}

function onCellBlur(tr: HTMLTableRowElement, td: HTMLTableCellElement, field: EditableField): void {
  const row = findRow(tr.dataset.id);
  if (!row) return;
  const result = editCell(state, row.id, field, td.textContent ?? "");
  if (!result.ok) {
    td.textContent = displayValue(row, field);
    setStatus(result.error, true);
    return;
  }
  if (result.state !== state) setState(result.state);
  const updated = findRow(row.id);
  if (!updated) return;
  td.textContent = displayValue(updated, field);
  paintRow(tr, updated);
  renderBanner();
}

function buildRow(row: Row, index: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.id = row.id;

  const num = document.createElement("td");
  num.className = "row-num";
  num.textContent = String(index + 1);
  tr.appendChild(num);

  const status = document.createElement("td");
  status.className = "status-cell";
  tr.appendChild(status);

  for (const field of EDITABLE_FIELDS) {
    const td = document.createElement("td");
    try {
      td.contentEditable = "plaintext-only";
    } catch {
      td.contentEditable = "true"; // older browsers
    }
    td.dataset.field = field;
    td.setAttribute("aria-label", `${COLUMN_LABELS[field]}, row ${index + 1}`);
    td.textContent = displayValue(row, field);
    td.addEventListener("blur", () => onCellBlur(tr, td, field));
    td.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        td.blur();
      }
    });
    tr.appendChild(td);
  }

  const action = document.createElement("td");
  action.className = "action-cell";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-del";
  del.textContent = "×";
  del.title = "Delete this row";
  del.setAttribute("aria-label", `Delete row ${index + 1}`);
  del.addEventListener("click", () => {
    setState(deleteRow(state, row.id));
    renderLedger();
  });
  action.appendChild(del);
  tr.appendChild(action);

  paintRow(tr, row);
  return tr;
}

function renderLedger(): void {
  const has = state.rows.length > 0;
  ui.table.style.display = has ? "table" : "none";
  ui.empty.style.display = has ? "none" : "block";
  ui.exportRow.style.display = has ? "flex" : "none";

  ui.body.replaceChildren(...state.rows.map(buildRow));
  renderBanner();

  ui.skippedBox.style.display = state.skipped.length ? "block" : "none";
  ui.skippedList.replaceChildren(
    ...state.skipped.map((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      return li;
    }),
  );
}

ui.dismissSkipped.addEventListener("click", () => {
  setState(dismissSkipped(state));
  renderLedger();
});

ui.clearLedger.addEventListener("click", () => {
  if (!window.confirm("Clear the whole ledger? Export first if you want to keep it.")) return;
  setState(clearLedger(state));
  renderLedger();
  setStatus("", false);
});

// ---- posting ----------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Please try again.";
}

async function processEntries(): Promise<void> {
  if (busy) return;
  const pending = pendingLines(state);
  if (pending.length === 0) {
    if (state.lines.length > 0) setStatus("Everything in the notebook is already posted. Add more lines to post them.", false);
    else setStatus("Add at least one line first.", true);
    return;
  }
  if (!connection.apiKey) {
    setConnOpen(true);
    ui.apiKey.focus();
    setStatus("Add your API key under Connection first.", true);
    return;
  }

  busy = true;
  ui.process.disabled = true;
  const chunks = chunkLines(pending);
  let posted = 0;
  let failure: string | null = null;

  try {
    for (const [i, chunk] of chunks.entries()) {
      setStatus(
        chunks.length > 1 ? `Posting batch ${i + 1} of ${chunks.length}…` : "Reading the notebook and posting entries…",
        false,
        true,
      );
      try {
        const result = await postParse({
          baseUrl: API_URL,
          provider: connection.provider,
          apiKey: connection.apiKey,
          text: chunkText(chunk),
          today: localToday(),
          categories: state.categories,
        });
        setState(applyBatch(state, chunk.map((l) => l.id), result));
        posted += result.entries.length;
        renderChatlog();
        renderLedger();
      } catch (err) {
        failure = errorMessage(err);
        break;
      }
    }
  } finally {
    busy = false;
    ui.process.disabled = false;
  }

  const needReview = pendingReviewCount(state);
  const reviewNote = needReview ? `, ${needReview} to review` : "";
  const entries = `${posted} ${posted === 1 ? "entry" : "entries"}`;
  if (failure) {
    setStatus(
      posted > 0
        ? `Posted ${entries}${reviewNote}, then stopped: ${failure} The remaining lines are still in the notebook.`
        : `Could not post entries: ${failure}`,
      true,
    );
  } else if (posted === 0) {
    setStatus("No transactions found in those notes.", false);
  } else {
    setStatus(`Posted ${entries}${reviewNote}.`, false);
  }
}
ui.process.addEventListener("click", () => void processEntries());

// ---- export -----------------------------------------------------------------

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportAs(kind: "csv" | "tsv" | "json" | "journal"): void {
  if (state.rows.length === 0) return;
  const n = pendingReviewCount(state);
  if (n > 0 && !window.confirm(`${n} ${n === 1 ? "row still needs" : "rows still need"} review. Export anyway?`)) return;

  const stamp = localToday();
  switch (kind) {
    case "csv":
      // BOM so Excel reads non-ASCII payees as UTF-8.
      download(`babbleledger-${stamp}.csv`, "﻿" + toCsv(state.rows), "text/csv;charset=utf-8");
      break;
    case "tsv":
      download(`babbleledger-${stamp}.tsv`, toTsv(state.rows), "text/tab-separated-values;charset=utf-8");
      break;
    case "json":
      download(`babbleledger-${stamp}.json`, JSON.stringify(ledgerRecords(state.rows), null, 2), "application/json");
      break;
    case "journal":
      download(`babbleledger-${stamp}.journal`, toJournal(state.rows), "text/plain;charset=utf-8");
      break;
  }
}
ui.exportCsv.addEventListener("click", () => exportAs("csv"));
ui.exportTsv.addEventListener("click", () => exportAs("tsv"));
ui.exportJson.addEventListener("click", () => exportAs("json"));
ui.exportJournal.addEventListener("click", () => exportAs("journal"));

// ---- boot -------------------------------------------------------------------

async function boot(): Promise<void> {
  buildHead();
  renderConnection();
  renderChatlog();
  renderLedger();
  renderCategories();

  state = restoreState(await loadSavedState());
  renderChatlog();
  renderLedger();
  renderCategories();
  if (state.lines.length || state.rows.length) setStatus("Picked up where you left off.", false);

  window.addEventListener("pagehide", () => void saveState(state));
}

void boot();
