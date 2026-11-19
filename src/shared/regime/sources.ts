// The source catalog and how much each voice counts. Glassnode is the reference: the source the thesis is checked
// against first, with the highest single weight. Everything else counts too, by kind, so the call reflects the whole
// field and not one shop's opinion. A source found by web search that is not in the catalog gets its kind's weight.
import type { SourceKind } from "./types.js";

export type SourceDef = {
  id: string;
  name: string;
  kind: SourceKind;
  /** 0..1. */
  weight: number;
  /** Hosts that map a search result to this source. */
  hosts?: string[];
  reference?: boolean;
};

/** Default weight for a source by kind, when it is not in the catalog. */
export const KIND_WEIGHT: Record<SourceKind, number> = {
  onchain_research: 0.8,
  flows: 0.75,
  derivatives: 0.7,
  sentiment: 0.45,
  macro: 0.7,
  analyst: 0.55,
  news: 0.25,
  // His own synthesis repeats the other sources, so it counts lightly to avoid double counting.
  own_notes: 0.3,
};

export const SOURCES: SourceDef[] = [
  { id: "glassnode", name: "Glassnode (Week On-chain)", kind: "onchain_research", weight: 1, hosts: ["glassnode.com", "research.glassnode.com", "insights.glassnode.com"], reference: true },
  { id: "cryptoquant", name: "CryptoQuant", kind: "onchain_research", weight: 0.8, hosts: ["cryptoquant.com"] },
  { id: "checkonchain", name: "Checkonchain", kind: "onchain_research", weight: 0.75, hosts: ["checkonchain.com", "newsletter.checkonchain.com"] },
  { id: "bitcoin-data", name: "bitcoin-data.com (STH cost basis, ETF flow)", kind: "onchain_research", weight: 0.6, hosts: ["bitcoin-data.com"] },
  { id: "farside", name: "Farside (ETF flows)", kind: "flows", weight: 0.85, hosts: ["farside.co.uk"] },
  { id: "coinshares", name: "CoinShares fund flows", kind: "flows", weight: 0.7, hosts: ["coinshares.com"] },
  { id: "defillama", name: "DefiLlama stablecoins", kind: "flows", weight: 0.7, hosts: ["defillama.com", "llama.fi"] },
  { id: "deribit", name: "Deribit options (put/call OI, DVOL)", kind: "derivatives", weight: 0.65, hosts: ["deribit.com"] },
  { id: "hyperliquid", name: "Hyperliquid funding and open interest", kind: "derivatives", weight: 0.6, hosts: ["hyperliquid.xyz"] },
  { id: "coinglass", name: "CoinGlass (liquidations, OI)", kind: "derivatives", weight: 0.6, hosts: ["coinglass.com"] },
  { id: "fear-greed", name: "Fear & Greed (alternative.me)", kind: "sentiment", weight: 0.35, hosts: ["alternative.me"] },
  { id: "coinbase-premium", name: "Coinbase premium", kind: "sentiment", weight: 0.5 },
  { id: "coingecko", name: "CoinGecko global (dominance, market cap)", kind: "sentiment", weight: 0.3, hosts: ["coingecko.com"] },
  { id: "desk-regime", name: "Desk regime read (structure, cycle overlay)", kind: "derivatives", weight: 0.6 },
  { id: "cme-fedwatch", name: "CME FedWatch", kind: "macro", weight: 0.75, hosts: ["cmegroup.com"] },
  { id: "treasury", name: "US Treasury yields", kind: "macro", weight: 0.7, hosts: ["treasury.gov", "home.treasury.gov"] },
  { id: "k33", name: "K33 Research", kind: "analyst", weight: 0.6, hosts: ["k33.com"] },
  { id: "10x", name: "10x Research", kind: "analyst", weight: 0.55, hosts: ["10xresearch.com"] },
  { id: "galaxy", name: "Galaxy Research", kind: "analyst", weight: 0.55, hosts: ["galaxy.com"] },
  { id: "wintermute", name: "Wintermute", kind: "analyst", weight: 0.55, hosts: ["wintermute.com"] },
  { id: "coindesk", name: "CoinDesk", kind: "news", weight: 0.3, hosts: ["coindesk.com"] },
  { id: "theblock", name: "The Block", kind: "news", weight: 0.3, hosts: ["theblock.co"] },
  { id: "weekly-tape", name: "The Weekly Tape (his notes)", kind: "own_notes", weight: 0.3, hosts: ["notion.so", "notion.com"] },
];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

export const REFERENCE_SOURCE = SOURCES.find((s) => s.reference)!.id;

export const hostOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** The catalog entry for an id, or for a URL's host. */
export function sourceFor(id: string, url?: string | null): SourceDef | null {
  const s = BY_ID.get(id.toLowerCase().trim());
  if (s) return s;
  const h = hostOf(url) ?? id.replace(/^web:/, "").toLowerCase();
  return SOURCES.find((x) => x.hosts?.some((d) => h === d || h.endsWith(`.${d}`))) ?? null;
}

/** The weight a read counts with: the catalog's, else the kind's. */
export function weightFor(id: string, kind: SourceKind, url?: string | null): number {
  return sourceFor(id, url)?.weight ?? KIND_WEIGHT[kind] ?? 0.3;
}

export const KINDS = Object.keys(KIND_WEIGHT) as SourceKind[];
export const isKind = (x: unknown): x is SourceKind => typeof x === "string" && (KINDS as string[]).includes(x);
