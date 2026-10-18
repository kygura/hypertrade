// Tab completion for the prompt line. Pure; the UI owns selection state.
import { ALIASES, COMMAND_NAMES, SORT_KEYS } from "./parse.js";

export interface CompleteCtx {
  /** Coin symbols, already ordered by OI desc. */
  coins: string[];
  oids?: number[];
}

const COIN_CMDS = new Set(["coin", "book", "long", "short", "close", "stop"]);
const ALL_COMMANDS = [...COMMAND_NAMES, ...Object.keys(ALIASES)].map((c) => "/" + c);

function lcp(items: string[]): string {
  let p = items[0] ?? "";
  for (const s of items) {
    let i = 0;
    while (i < p.length && i < s.length && p[i]!.toLowerCase() === s[i]!.toLowerCase()) i++;
    p = p.slice(0, i);
  }
  return p;
}

export function complete(input: string, ctx: CompleteCtx): { completed: string; options: string[] } {
  const none = { completed: input, options: [] as string[] };
  if (!input.startsWith("/")) return none;
  const toks = input.split(/\s+/);
  const cur = toks.pop()!; // "" when input ends in whitespace
  const head = input.slice(0, input.length - cur.length);

  let pool: string[];
  if (toks.length === 0) {
    pool = ALL_COMMANDS;
  } else {
    const raw = toks[0]!.slice(1).toLowerCase();
    const cmd = ALIASES[raw] ?? raw;
    const argIdx = toks.length - 1; // index among arguments
    if (COIN_CMDS.has(cmd) && argIdx === 0) pool = ctx.coins;
    else if (cmd === "markets" && !toks.slice(1).some((t) => (SORT_KEYS as readonly string[]).includes(t.toLowerCase()))) pool = [...SORT_KEYS];
    else if (cmd === "cancel" && argIdx === 0) pool = ["all", ...(ctx.oids ?? []).map(String)];
    else if (cmd === "cancel" && argIdx === 1) pool = ctx.coins;
    else return none;
  }

  const q = cur.toLowerCase();
  const options = pool.filter((s) => s.toLowerCase().startsWith(q));
  if (options.length === 0) return none;
  if (options.length === 1) return { completed: head + options[0] + " ", options };
  const common = lcp(options);
  return { completed: head + (common.length > cur.length ? common : cur), options };
}
