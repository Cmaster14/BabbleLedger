import type { LedgerEntry } from "./schema";

/**
 * Enforce a user-defined category list after parsing. The prompt asks the model
 * to stay inside the list, but the model is never the last line of defence:
 * a case-insensitive match is snapped to the user's own spelling, and anything
 * off-list is flagged for review instead of being silently accepted.
 */
export function applyCategoryList(entry: LedgerEntry, categories: readonly string[] | undefined): LedgerEntry {
  if (!categories || categories.length === 0) return entry;

  const wanted = entry.category.trim().toLowerCase();
  const match = categories.find((c) => c.trim().toLowerCase() === wanted);
  if (match) return match === entry.category ? entry : { ...entry, category: match };

  if (entry.uncertainFields.includes("category")) return entry;
  return { ...entry, uncertainFields: [...entry.uncertainFields, "category"] };
}
