import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { HEATMAP_METRICS, type Alert, type FlowFlag, type HeatmapResponse } from "../../../shared/intel";
import type { IntelState } from "../../lib/intel";
import { AlertItem } from "./AlertItem";
import { paneOf, timelineRows } from "./AssetTimeline";
import { flowEventText } from "./EventList";
import { cellTitle, chipText, degradedChips, firingChips, flagWord, fmtHeatDelta, HEAT_COLUMNS, numbersLine, zBucket } from "./flow";
import { FlowPanel } from "./FlowPanel";
import { terminalTabOf } from "./TerminalTabs";

// DESIGN-terminal §15: pure helpers (z bucket, column order, chip copy) plus
// render-checks (react-dom/server, no jsdom) of the FLOW panel's named states.

const ts = "2026-10-14T12:00:00.000Z";
const flag = (p: Partial<FlowFlag>): FlowFlag => ({ id: `${p.name}:${p.asset}:${p.ts ?? ts}`, asset: "HYPE", kind: "detector", name: "crowded_long", window: "24h", numbers: {}, score: 2, degraded: false, ts, ...p });

describe("zBucket", () => {
  test("bucketed at |z| 1 and 2, null empty", () => {
    expect([null, 0, 0.99, -0.99, 1, 1.99, 2, 5, -1, -1.99, -2, Number.NaN].map(zBucket)).toEqual(["null", "zero", "zero", "zero", "pos1", "pos1", "pos2", "pos2", "neg1", "neg1", "neg2", "null"]);
  });
});

describe("HEAT_COLUMNS", () => {
  test("pinned order matches the shared contract, 8 SNAPSHOT + 4 FLOW", () => {
    expect(HEAT_COLUMNS.map((c) => c.metric)).toEqual([...HEATMAP_METRICS]);
    expect(HEAT_COLUMNS.map((c) => c.header)).toEqual(["PRICE", "OI", "FUND", "BASIS", "PREM", "VOL", "DEPTH", "SPRD", "L/S", "LIQS", "PERP", "SPOT"]);
    expect(HEAT_COLUMNS.filter((c) => c.group === "snapshot")).toHaveLength(8);
    expect(HEAT_COLUMNS.slice(8).every((c) => c.group === "flow")).toBe(true);
  });

  test("cell title and null title per window", () => {
    expect(cellTitle("HYPE", "oi_usd", "6h", 3.12, 18.4)).toBe("HYPE open interest (USD) · 6h · Δ +18.4% · z +3.1");
    expect(cellTitle("HYPE", "oi_usd", "6h", null, null)).toBe("fewer than 48 samples");
    expect(cellTitle("HYPE", "oi_usd", "review", null, null)).toBe("fewer than 24 samples");
    expect(fmtHeatDelta("funding", 0.00002)).toBe("+0.0020%");
    expect(fmtHeatDelta("liq_usd", 1_200_000)).toBe("+$1.20M");
  });
});

describe("detector copy", () => {
  test("plain words, never code names", () => {
    const n = { funding_z: 2.4, oi_z_24h: 1.3, price_z_24h: 0.2, funding: 0.00004 };
    expect(chipText(flag({ numbers: n }))).toBe("CROWDED LONG · HYPE 24H");
    expect(numbersLine(flag({ numbers: n }))).toBe("funding z +2.4 · OI 24h z +1.3 · price 24h z +0.2");
    expect(flagWord(flag({ name: "negative_funding_oi_build" }))).toBe("NEG FUNDING + OI BUILD");
    expect(numbersLine(flag({ name: "deleveraging", window: "6h", numbers: { oi_pct_6h: -9.2, liq_z_6h: 2.8 } }))).toBe("OI 6h −9.2% · liqs 6h z +2.8");
    expect(flagWord(flag({ name: "liquidity_thinning" }))).toBe("THIN BOOK");
    expect(numbersLine(flag({ name: "liquidity_thinning", numbers: { depth_2: 1_200_000, p10: 1_500_000 } }))).toBe("depth ±2% $1.20M · 30d p10 $1.50M");
    const flip = flag({ kind: "flip", name: "funding_flip", numbers: { from: -0.00002, to: 0.00001 } });
    expect(flagWord(flip)).toBe("FUNDING FLIPPED +");
    expect(numbersLine(flip)).toBe("−0.002% → +0.001%");
    expect(flagWord(flag({ kind: "flip", name: "basis_flip", numbers: { from: 0.00008, to: -0.00004 } }))).toBe("BASIS INVERTED");
    const cross = flag({ kind: "crossing", name: "funding>0.0000625", numbers: { from: 0.00005, to: 0.0000763, threshold: 0.0000625 } });
    expect(flagWord(cross)).toBe("FUNDING > 0.05%/8H");
    expect(numbersLine(cross)).toBe("now 0.061%/8h");
    expect(flowEventText({ title: "crowded_long", numbers: { funding_z: 2.4 } })).toBe("crowded long · funding z +2.4");
    expect(flowEventText({ title: "Some server sentence" })).toBe("Some server sentence");
  });

  test("firing chips: one per (name, asset), materiality then newest; degraded split out", () => {
    const old = flag({ asset: "SOL", name: "spot_led", ts: "2026-10-14T10:00:00.000Z" });
    const fresh = flag({ asset: "SOL", name: "spot_led", ts: "2026-10-14T11:00:00.000Z" });
    const hype = flag({ asset: "HYPE" });
    const deg = [flag({ asset: "HYPE", name: "deleveraging", degraded: true }), flag({ asset: "SOL", name: "deleveraging", degraded: true })];
    const out = firingChips([hype, old, fresh, ...deg], new Map([["SOL", 0.9], ["HYPE", 0.4]]));
    expect(out.map((f) => f.id)).toEqual([fresh.id, hype.id]);
    const d = degradedChips(deg);
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toBe("DELEVERAGING · NO LIQ DATA");
    expect(d[0]!.reason).toContain("HYPE, SOL");
  });
});

describe("asset page helpers", () => {
  test("timeline merges snapshots and flow on one axis; liqs = long + short", () => {
    const snap = { asset: "HYPE", ts, price: 32, vol24h: null, funding: 0.0001, oiUsd: 1e9, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: 1, depthAsk2: 2, spreadBps: 1 };
    const rows = timelineRows([snap], [
      { asset: "HYPE", venue: "agg", metric: "liq_long_usd", value: 5, ts },
      { asset: "HYPE", venue: "agg", metric: "liq_short_usd", value: 7, ts },
      { asset: "HYPE", venue: "agg", metric: "long_short_ratio", value: 1.4, ts: "2026-10-14T11:45:00.000Z" },
    ]);
    expect(rows.map((r) => r.t)).toEqual([Date.parse("2026-10-14T11:45:00.000Z"), Date.parse(ts)]);
    expect(rows[1]).toMatchObject({ price: 32, depth: 3, liqs: 12, funding: 0.01 });
    expect(rows[0]!.ls).toBe(1.4);
  });

  test("?metric= maps to a pane; /asset/:coin is the TERMINAL tab", () => {
    expect(paneOf("funding")).toBe("funding");
    expect(paneOf("spread_bps")).toBe("depth");
    expect(paneOf("perp_volume_usd")).toBeNull();
    expect(terminalTabOf("/asset/HYPE")).toBe("terminal");
  });
});

describe("FlowPanel states", () => {
  const state = (p: Partial<IntelState<HeatmapResponse>>): IntelState<HeatmapResponse> => ({ data: null, loading: false, error: null, offline: null, fetchedAt: null, refetch: () => {}, setData: () => {}, ...p });
  const render = (s: IntelState<HeatmapResponse>) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <FlowPanel state={s} window="6h" onWindow={() => {}} />
      </MemoryRouter>,
    );
  const data: HeatmapResponse = {
    rows: [{ asset: "HYPE", held: true, materiality: 0.7 }, { asset: "ETH", held: false, materiality: 0.1 }],
    metrics: [...HEATMAP_METRICS],
    cells: [
      { asset: "HYPE", metric: "oi_usd", z: 3.1, delta: 18.4 },
      { asset: "HYPE", metric: "price", z: 0.4, delta: 0.2 },
      { asset: "HYPE", metric: "liq_usd", z: 2.5, delta: 1e6 },
    ],
    flags: [flag({ numbers: { funding_z: 2.4 } })],
    flow: { ok: false, error: "no_source" },
    asOf: new Date().toISOString(),
  };

  test("skeleton, offline, error, empty", () => {
    expect(render(state({ loading: true }))).toContain("pulse-label");
    expect(render(state({ offline: "api unreachable" }))).toContain("API UNREACHABLE");
    expect(render(state({ error: "boom" }))).toContain("boom");
    expect(render(state({ data: { ...data, rows: [] } }))).toContain("nothing held or watched");
  });

  test("grid: window switch, ramp, sticky asset, FLOW · NO SOURCE, flags", () => {
    const html = render(state({ data }));
    expect(html).toContain('aria-label="flow window"');
    expect(html).toContain("FLOW · NO SOURCE");
    expect(html).toContain("var(--color-mom-pos2)");
    expect(html).toContain(">+3.1<");
    expect(html).toContain("sticky left-0");
    expect(html).toContain("CROWDED LONG · HYPE 24H");
    expect(html).toContain(">crowded long<");
    // no source: the FLOW cells stay null even when the server sent a z
    expect(html).not.toContain(">+2.5<");
    expect(html).toContain("no flow source configured — see docs/research/flow-sources.md");
    expect(html.match(/<tr[^>]*tabindex="0"/g) ?? []).toHaveLength(2);
    expect(html).not.toContain("no detectors firing");
  });
});

describe("LLM cap copy", () => {
  test("an alert whose narration failed shows the verbatim reason in place of its line", () => {
    const a: Alert = {
      id: "a1", kind: "mapper", ref: "c1", window: null, asset: "SOL", title: "x", eventType: null,
      line: { tag: "hypothesis", text: "Long SOL. Exposed via Jito." }, path: [], edgeType: null, hops: 1, pathWeight: 1,
      sources: [], materiality: 0.5, pricedIn: null, route: "batch", feedback: null, createdAt: ts,
      trace: { promptVersion: "v", tier: "cheap", model: null, inputs: null, output: null, usage: null, ms: 0, error: "LLM cap reached ($1.37 / $2.00)" },
    };
    const html = renderToStaticMarkup(<AlertItem alert={a} onVote={async () => {}} />);
    expect(html).toContain("no narration — LLM cap reached ($1.37 / $2.00)");
    expect(html).not.toContain("Exposed via Jito");
  });
});
