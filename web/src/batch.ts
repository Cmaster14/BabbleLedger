import type { NoteLine } from "./state";

export interface ChunkLimits {
  /** Stay comfortably under the API's 8000-character request limit. */
  maxChars: number;
  /** Bound the reply size so a long notebook can't truncate the model's JSON. */
  maxLines: number;
}

export const DEFAULT_LIMITS: ChunkLimits = { maxChars: 6000, maxLines: 25 };

/**
 * Group pending lines into requests. Order is preserved. A single line longer
 * than the limit gets a request of its own (the API will reject it with a clear
 * error rather than us silently truncating the user's note).
 */
export function chunkLines(lines: readonly NoteLine[], limits: ChunkLimits = DEFAULT_LIMITS): NoteLine[][] {
  const chunks: NoteLine[][] = [];
  let current: NoteLine[] = [];
  let size = 0;

  for (const line of lines) {
    const add = line.text.length + 1; // +1 for the joining newline
    if (current.length > 0 && (current.length >= limits.maxLines || size + add > limits.maxChars)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += add;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function chunkText(chunk: readonly NoteLine[]): string {
  return chunk.map((l) => l.text).join("\n");
}
