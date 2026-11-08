import { z } from "zod";

/**
 * Core ledger schema. Fixed columns plus a free-text memo, so the exported
 * data is predictable while anything unusual still has somewhere to live.
 */
export const LedgerEntrySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
    .nullable()
    .describe(
      "Transaction date as YYYY-MM-DD. Resolve relative dates ('yesterday', 'last Friday') against the supplied current date. Use null if the note gives no usable date.",
    ),
  type: z
    .enum(["expense", "income"])
    .describe("'expense' for money spent, 'income' for money received or refunded."),
  amount: z
    .number()
    .positive()
    .describe("Absolute amount as a positive number. Direction is carried by 'type'."),
  currency: z
    .string()
    .length(3)
    .describe("ISO 4217 currency code, e.g. USD. Assume USD when the note has no currency hint."),
  payee: z.string().min(1).describe("Who was paid or who paid. Keep it short, e.g. 'Costco'."),
  category: z
    .string()
    .min(1)
    .describe(
      "Short lowercase category such as groceries, dining, fuel, rent, utilities, transport, health, entertainment, shopping, income, other.",
    ),
  memo: z.string().describe("Any extra detail from the note worth keeping. Empty string if none."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Your confidence that this row is correct. Lower it when you guessed the amount, date, payee or category.",
    ),
  uncertainFields: z
    .array(z.enum(["date", "type", "amount", "currency", "payee", "category"]))
    .describe("Fields you guessed or could not determine. Empty array if you are sure of all of them."),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** What the model returns for one block of notes. */
export const ModelOutputSchema = z.object({
  entries: z.array(LedgerEntrySchema),
  unparsed: z
    .array(z.string())
    .describe("Pieces of the input that did not describe a transaction, verbatim. Empty array if none."),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/** Entry as returned to the client, with the review decision added server-side. */
export type ParsedEntry = LedgerEntry & { needsReview: boolean };

export interface ParseResult {
  entries: ParsedEntry[];
  unparsed: string[];
}

/** Rows below this confidence, or with any uncertain field, go to the review screen. */
export const REVIEW_THRESHOLD = 0.8;

export function needsReview(entry: LedgerEntry): boolean {
  return (
    entry.confidence < REVIEW_THRESHOLD ||
    entry.uncertainFields.length > 0 ||
    entry.date === null
  );
}

export const PROVIDERS = ["anthropic", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Limits for the optional user-defined category list (also enforced by the UI). */
export const MAX_CATEGORIES = 30;
export const MAX_CATEGORY_LENGTH = 40;

/** Request body for POST /parse. The API key is used for this request only. */
export const ParseRequestSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  /** Client's local date (YYYY-MM-DD) so relative dates resolve in the user's timezone. */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.enum(PROVIDERS).default("anthropic"),
  apiKey: z.string().min(10).max(400),
  model: z.string().min(1).max(100).optional(),
  /** Optional user-defined categories. When present, every entry is sorted into one of them. */
  categories: z.array(z.string().trim().min(1).max(MAX_CATEGORY_LENGTH)).max(MAX_CATEGORIES).optional(),
});
export type ParseRequest = z.infer<typeof ParseRequestSchema>;
