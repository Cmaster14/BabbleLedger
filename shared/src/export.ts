import type { LedgerEntry } from "./schema";

const CSV_HEADER = ["date", "type", "amount", "currency", "payee", "category", "memo"] as const;

/** Neutralise spreadsheet formula injection (cells starting with = + - @ tab CR). */
function neutralise(value: string | number | null): string {
  const s = value === null ? "" : String(value);
  return typeof value === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(value: string | number | null): string {
  const s = neutralise(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tsvCell(value: string | number | null): string {
  // Tabs and newlines would break the grid when pasted into a spreadsheet.
  return neutralise(value).replace(/[\t\r\n]+/g, " ");
}

function fields(e: LedgerEntry): (string | number | null)[] {
  return [e.date, e.type, e.amount.toFixed(2), e.currency, e.payee, e.category, e.memo];
}

export function toCsv(entries: LedgerEntry[]): string {
  const rows = entries.map((e) => fields(e).map(csvCell).join(","));
  return [CSV_HEADER.join(","), ...rows].join("\n") + "\n";
}

/** Tab-separated, for pasting straight into Excel or Google Sheets. */
export function toTsv(entries: LedgerEntry[]): string {
  const rows = entries.map((e) => fields(e).map(tsvCell).join("\t"));
  return [CSV_HEADER.join("\t"), ...rows].join("\n") + "\n";
}

/**
 * Minimal plaintext journal (hledger-style). Entries with no date are listed
 * under an undated comment so nothing is silently dropped.
 */
export function toJournal(entries: LedgerEntry[]): string {
  const blocks = entries.map((e) => {
    const date = e.date ?? "0000-00-00 ; DATE UNKNOWN";
    const memo = e.memo ? `  ; ${e.memo.replace(/\s+/g, " ")}` : "";
    const account = `${e.type === "expense" ? "expenses" : "income"}:${e.category.replace(/\s+/g, "-")}`;
    const sign = e.type === "expense" ? "" : "-";
    return [
      `${date} ${e.payee}${memo}`,
      `    ${account}    ${sign}${e.amount.toFixed(2)} ${e.currency}`,
      `    assets:unknown`,
    ].join("\n");
  });
  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}
