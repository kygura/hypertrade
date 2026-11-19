// The regime thesis: one living document about where the crypto market sits (BTC-led), rewritten in place each time
// new intelligence arrives, with a dated changelog of how each piece of intel moved it. Shapes only; no imports, so the
// core (src/shared/regime/ here, src/intel/core/ in tradespace) is the same set of files in both repos.

/** How a source leans on the market from here: -2 strongly bearish … +2 strongly bullish. */
export type Lean = -2 | -1 | 0 | 1 | 2;

/** What kind of evidence a source gives. Weights differ by kind (sources.ts). */
export type SourceKind =
  | "onchain_research" // Glassnode, CryptoQuant, Checkonchain: cost bases, realized P/L, holder cohorts
  | "flows" // ETF flows, stablecoin supply, exchange flows, treasury buying
  | "derivatives" // funding, open interest, liquidations, options positioning and implied vol
  | "sentiment" // Fear & Greed, Coinbase premium, social
  | "macro" // rates, dollar, Fed pricing, equities
  | "analyst" // desks and research shops: K33, 10x, Wintermute, Galaxy, sell-side
  | "news" // reporting of events
  | "own_notes"; // his own synthesis (the Weekly Tape)

/** One piece of intelligence as collected, before any reading of it. */
export type Evidence = {
  /** Stable id: source + url or source + day for data snapshots. */
  id: string;
  /** Source id from the catalog (e.g. "glassnode"), or "web:<host>" for something found by search. */
  source: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  /** When the source published it (ISO), if known. */
  published: string | null;
  /** When the pipeline picked it up (ISO). */
  collected: string;
  /** The text the reader sees: a report body, a feed summary, or a one-line rendering of the numbers. */
  text: string;
  /** Raw numbers for data snapshots. */
  data?: Record<string, number | string | null>;
};

/** What one source says, as read for this version of the thesis. `weight` is filled in by code, never by the model. */
export type SourceRead = {
  source: string;
  name: string;
  kind: SourceKind;
  lean: Lean;
  /** 0..1: how firmly the source states it (a hedged teaser is low, a full report with numbers is high). */
  confidence: number;
  /** One or two sentences: the claim, with its numbers. */
  claim: string;
  url: string | null;
  as_of: string | null;
  weight: number;
};

export type Agreement = "aligned" | "split" | "contested" | "thin";

/** Weighted read across every source, computed by code from the source reads (consensus.ts). */
export type Consensus = {
  /** -2..+2, the weighted mean lean. */
  score: number;
  label: "bearish" | "lean bearish" | "mixed" | "lean bullish" | "bullish";
  /** Weighted standard deviation of the leans: 0 when every source agrees. */
  dispersion: number;
  agreement: Agreement;
  /** Sources counted. */
  n: number;
  /** Weighted mean lean per kind of source. */
  by_kind: Partial<Record<SourceKind, number>>;
  /** The reference source (Glassnode) and whether the rest of the field agrees with it. */
  reference: { source: string; lean: Lean } | null;
  reference_vs_field: "agrees" | "differs" | "no_reference" | "no_field";
};

export type Stance = "risk_off" | "defensive" | "neutral" | "constructive" | "risk_on";
export type Conviction = "low" | "medium" | "high";

export type KeyLevel = {
  metric: string;
  /** The level as text ("$62K-$66K", "~5.10%"). */
  level: string;
  /** The number to compare price with, when there is one (BTC levels). */
  price: number | null;
  meaning: string;
  status: string;
  /** Source ids or names behind it. */
  sources: string[];
  as_of: string | null;
};

/** The lines that change the call: what confirms the bull case, what triggers the bear case. */
export type ThesisLine = { kind: "bull_confirm" | "bear_trigger" | "invalidation"; text: string; price: number | null };

export type Scenario = { name: string; probability: number; path: string; trigger: string };

export type Catalyst = { date: string | null; event: string; why: string; status: "upcoming" | "resolved" };

export type Narrative = { name: string; read: string };

/** One thing this version changed, and which intel moved it. */
export type ThesisChange = { what: string; from: string | null; to: string; because: string; sources: string[] };

export type Link = { title: string; url: string };

export type RegimeThesis = {
  id: string;
  /** 1 for the first document, +1 every rewrite. */
  version: number;
  created: string;
  /** "seed" for a document seeded from his notes, else the model that wrote it. */
  model: string;
  /** One line, the call: "Breakdown into capitulation, testing the August block". */
  phase: string;
  stance: Stance;
  conviction: Conviction;
  /** 3 to 5 plain sentences; the reader may stop here. */
  tldr: string;
  /** Dominant macro constraint, in prose. */
  macro: string;
  /** Altcoin conditions, in prose. */
  alts: string;
  key_levels: KeyLevel[];
  lines: ThesisLine[];
  scenarios: Scenario[];
  source_reads: SourceRead[];
  consensus: Consensus;
  /** Where the sources agree and where they part, named. */
  agreement_notes: string;
  catalysts: Catalyst[];
  narratives: Narrative[];
  changes: ThesisChange[];
  /** A few sentences: this version's changelog entry. */
  changelog: string;
  sources: Link[];
  /** Evidence ids this version read. */
  evidence: string[];
  usage: { input_tokens: number; output_tokens: number; web_searches: number };
};

/** The changelog, one row per version, newest first. Kept much longer than full versions. */
export type HistoryEntry = {
  id: string;
  version: number;
  created: string;
  phase: string;
  stance: Stance;
  conviction: Conviction;
  consensus: number | null;
  changelog: string;
};
