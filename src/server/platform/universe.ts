import { z } from "zod";
import type { LlmDeps } from "../intel/llm.js";
import type { ToolSpec } from "../llm/provider.js";
import { SECTORS, SectorSchema, type SectorTag } from "../../shared/platform.js";
import type { PlatformStore } from "./store.js";

// Shared coin universe for lab_event_study and the novelty loop (PS-B5). Sector tags only filter, never score.

export const DEFAULT_MY_MARKETS = "BTC,ETH,HYPE,SOL,XPL,LIT,ZEC";
export const myMarkets = (env: string | undefined = process.env.PLATFORM_MY_MARKETS): string[] =>
  (env?.trim() || DEFAULT_MY_MARKETS).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

export interface UniverseOpts {
  /** Keep the N most liquid coins (by dayNtlVlm). */
  top?: number;
  /** Keep coins carrying any of these sectors. */
  sectors?: string[];
  /** Coins always added (those that exist in the input). */
  mine?: string[];
  /** coin -> sectors; a coin without tags never matches a sector filter. */
  tags?: Record<string, string[]>;
}

/**
 * Filters intersect (top-N by liquidity, then sectors); `mine` is added on top (union).
 * Only `mine` given: just those coins. Nothing given: the whole input. Most liquid first.
 */
export function selectUniverse<T extends { coin: string; dayNtlVlm: number }>(ctxs: T[], o: UniverseOpts = {}): T[] {
  const sorted = [...ctxs].sort((a, b) => b.dayNtlVlm - a.dayNtlVlm || (a.coin < b.coin ? -1 : 1));
  const filtered = o.top !== undefined || o.sectors?.length;
  if (!filtered && !o.mine) return sorted;
  let base = filtered ? sorted : [];
  if (o.top !== undefined) base = base.slice(0, o.top);
  if (o.sectors?.length) base = base.filter((c) => o.tags?.[c.coin]?.some((s) => o.sectors!.includes(s)));
  const mine = new Set(o.mine ?? []);
  const keep = new Set(base.map((c) => c.coin));
  return sorted.filter((c) => keep.has(c.coin) || mine.has(c.coin));
}

/** PLATFORM_NOVELTY_UNIVERSE: `;`-separated `mine`, `top:N`, `sectors:A,B`. Throws on anything else. */
export function parseUniverseSpec(spec: string): UniverseOpts {
  const o: UniverseOpts = {};
  for (const part of spec.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [k, ...rest] = part.split(":");
    const v = rest.join(":");
    if (k === "mine" && !v) o.mine = myMarkets();
    else if (k === "top" && /^[1-9]\d*$/.test(v)) o.top = Number(v);
    else if (k === "sectors") o.sectors = z.array(SectorSchema).min(1).parse(v.split(",").map((s) => s.trim()));
    else throw new Error(`bad universe spec "${part}" (mine | top:N | sectors:A,B)`);
  }
  return o;
}

const SYSTEM = `You tag crypto perpetual-futures coins with narrative sectors. For each coin pick 1 to 3 sectors, ONLY from: ${SECTORS.join(", ")}. Use "Other" when none fits or you do not recognise the ticker. Do not invent sectors.`;
const jsonSchema: ToolSpec["input_schema"] = {
  type: "object",
  properties: {
    tags: {
      type: "array",
      items: {
        type: "object",
        properties: { coin: { type: "string" }, sectors: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: [...SECTORS] } } },
        required: ["coin", "sectors"],
      },
    },
  },
  required: ["tags"],
};
export const SECTOR_PROMPT_VERSION = "sectors-1";
/** Zod is the trust boundary: one unknown sector rejects the whole answer (the repair round gets one retry). */
export const sectorAnswerSchema = z.object({ tags: z.array(z.object({ coin: z.string(), sectors: z.array(SectorSchema).min(1).max(3) }).strict()) }).strict();

let defaultLlm: Promise<LlmDeps> | undefined;
/** Same construction as the lab service's lazy LLM deps. Dynamic import: the Intel/Desk graph imports the lab tools (cycle). */
export const defaultLlmDeps = (): Promise<LlmDeps> =>
  (defaultLlm ??= Promise.all([import("../intel/llm.js"), import("../routine/llm.js")]).then(
    ([{ intelProviderFactory }, { MemoryLlmCache }]): LlmDeps => ({ makeProvider: intelProviderFactory(), cache: new MemoryLlmCache(), now: () => new Date(), dailyCap: 100 }),
  ));

/**
 * Tags only the coins the store has no tags for (new listings), in one LLM call, and caches them. Returns coin -> sectors for
 * everything cached. An LLM failure leaves those coins untagged; it never throws.
 */
export async function ensureSectors(
  coins: string[],
  store: Pick<PlatformStore, "listSectors" | "saveSectors">,
  llm: () => Promise<LlmDeps> = defaultLlmDeps,
  now: () => Date = () => new Date(),
): Promise<Record<string, string[]>> {
  const have = new Map((await store.listSectors()).map((t) => [t.coin, t]));
  const missing = [...new Set(coins)].filter((c) => !have.has(c));
  if (missing.length) {
    try {
      const { completeStructured } = await import("../intel/llm.js");
      const r = await completeStructured({
        tier: "cheap",
        system: SYSTEM,
        user: `Coins: ${missing.join(", ")}`,
        schema: sectorAnswerSchema,
        jsonSchema,
        promptVersion: SECTOR_PROMPT_VERSION,
        deps: await llm(),
      });
      if (r.ok) {
        const asked = new Set(missing);
        const tags: SectorTag[] = r.value.tags.filter((t) => asked.has(t.coin)).map((t) => ({ coin: t.coin, sectors: [...new Set(t.sectors)], taggedAt: now().toISOString() }));
        await store.saveSectors(tags);
        for (const t of tags) have.set(t.coin, t);
      } else console.error("[sectors] tagging failed:", r.error);
    } catch (err) {
      console.error("[sectors] tagging failed:", err instanceof Error ? err.message : err);
    }
  }
  return Object.fromEntries([...have].map(([c, t]) => [c, t.sectors]));
}
