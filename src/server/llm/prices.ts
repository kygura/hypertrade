/** Claude list prices, $/MTok (input, output). Callers own their unknown-model rule (intel prices it at the top row, the desk reports null). */
export const CLAUDE_PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};
