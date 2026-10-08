// MCP stdio framing: one JSON-RPC message per line, no embedded newlines.

/** Splits accumulated input into complete, non-blank lines plus the unterminated rest. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== ""), rest };
}

/** One outbound frame: compact JSON plus the terminating newline. */
export function frame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** Ids of the requests (not notifications) in a message or batch: who is owed a reply. */
export function owedIds(message: unknown): Array<string | number | null> {
  const list = Array.isArray(message) ? message : [message];
  return list
    .filter((m): m is { id: string | number | null; method: string } => typeof m === "object" && m !== null && "id" in m && "method" in m)
    .map((m) => m.id);
}
