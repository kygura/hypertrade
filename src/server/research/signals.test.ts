import { describe, expect, test } from "bun:test";
import type { NoveltyEntry, NoveltyFeature, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import { ResearchSignalSchema } from "../../shared/research.js";
import { transformSeries } from "../lab/engine/features.js";
import type { CatalogueEntry, MarketPulse, Rule } from "../lab/types.js";
import { NOVELTY_TABLE, noveltyCondition, noveltyRule, noveltySignal, opportunitySignal, radarSignal, ruleSignals, zIncludingCurrent } from "./signals.js";

const feat = (id: string, value: number): NoveltyFeature => ({ id, value, histMin: -1, histMax: 1, p1: -0.9, p99: 0.9, bars: 400, pctRank: 99.9 });
const entry = (features: NoveltyFeature[], over: Partial<NoveltyEntry> = {}): NoveltyEntry => ({
  id: "2026-11-08:ETH", detectedAt: "2026-11-09T00:10:00.000Z", barDate: "2026-11-08", coin: "ETH", kind: "new_extreme", families: ["funding"],
  features, nearSetups: [], marketWide: false, pushed: true, notified: [], ...over,
});
const valid = (s: unknown) => ResearchSignalSchema.extend({ evidence: ResearchSignalSchema.shape.evidence.optional() }).parse(s);

describe("novelty → Lab rule (fixed table)", () => {
  test("table rows: each feature → its Lab feature, side from the sign, threshold rounded toward zero", () => {
    // funding z90 +2.4 → Lab z incl. the day 2.31 → 2.0; ret(7) −12.3% → −0.10; volume 3x → ma_ratio 1.73 → 1.5
    expect(noveltyCondition(NOVELTY_TABLE.funding_z90!, 2.4)).toEqual({ feature: "ht:funding|z|90", op: ">=", threshold: 2 });
    expect(noveltyCondition(NOVELTY_TABLE.funding_z90!, -3.1)).toEqual({ feature: "ht:funding|z|90", op: "<", threshold: -2.5 });
    expect(noveltyCondition(NOVELTY_TABLE["ret(7)"]!, -0.123)).toEqual({ feature: "ht:price|roc|7", op: "<", threshold: -0.1 });
    expect(noveltyCondition(NOVELTY_TABLE["ret(7)"]!, 0.31)).toEqual({ feature: "ht:price|roc|7", op: ">=", threshold: 0.3 });
    expect(noveltyCondition(NOVELTY_TABLE.vol_x!, 3)).toEqual({ feature: "ht:volume|ma_ratio|20", op: ">=", threshold: 1.5 });
    expect(noveltyCondition(NOVELTY_TABLE.vol_x!, 0.1)).toEqual({ feature: "ht:volume|ma_ratio|20", op: "<", threshold: -0.5 });
    // below one step: the threshold is 0, never -0
    expect(Object.is(noveltyCondition(NOVELTY_TABLE["ret(7)"]!, -0.01).threshold, 0)).toBe(true);
  });

  test("the condition holds on the Lab value of the bar it came from", () => {
    for (const [id, m] of Object.entries(NOVELTY_TABLE)) {
      for (const x of id === "vol_x" ? [0.05, 0.4, 2, 3.7, 12] : [-6, -2.04, -0.3, 0.01, 0.49, 2.6, 9]) {
        const c = noveltyCondition(m, x);
        const lab = m.toLab(x);
        expect(c.op === ">=" ? lab >= c.threshold : lab < c.threshold).toBe(true);
      }
    }
  });

  test("zIncludingCurrent is the Lab z(n) of the bar given the z against the n−1 previous values", () => {
    const prev = Array.from({ length: 89 }, (_, i) => Math.sin(i) * 0.001 + 0.0001);
    const m = prev.reduce((a, b) => a + b, 0) / prev.length;
    const sd = Math.sqrt(prev.reduce((a, b) => a + (b - m) ** 2, 0) / (prev.length - 1));
    for (const z of [-4, 2.4, 7]) {
      const lab = transformSeries([...prev, m + z * sd], "z", 90).at(-1)!;
      expect(zIncludingCurrent(90)(z)).toBeCloseTo(lab, 9);
    }
  });

  test("vol_x → ma_ratio is exact when the previous 20 days are flat", () => {
    const lab = transformSeries([...Array(19).fill(100), 100, 350], "ma_ratio", 20).at(-1)!; // window: 19 × 100 and 350
    expect(NOVELTY_TABLE.vol_x!.toLab(3.5)).toBeCloseTo(lab, 9);
  });

  test("rule: up to two mapped features in table order; direction fades the first signed one; 7-day hold", () => {
    expect(noveltyRule(entry([feat("vol_x", 3), feat("ret(7)", -0.123), feat("funding_z90", 2.4), feat("oi_change(7)", 0.5)]))).toEqual({
      asset: "ETH", direction: "short", horizonDays: 7,
      conditions: [
        { feature: "ht:funding|z|90", op: ">=", threshold: 2 },
        { feature: "ht:price|roc|7", op: "<", threshold: -0.1 },
      ],
    });
    expect(noveltyRule(entry([feat("ret(7)", -0.2), feat("vol_x", 4)]))?.direction).toBe("long");
    expect(noveltyRule(entry([feat("ret(7)", -0.2), feat("vol_x", 4)]))?.conditions.map((c) => c.feature)).toEqual(["ht:price|roc|7", "ht:volume|ma_ratio|20"]);
    // volume alone has no side; unmapped features have no twin
    expect(noveltyRule(entry([feat("vol_x", 4)]))).toBeNull();
    expect(noveltyRule(entry([feat("rv5to60", 3), feat("oi_from_peak(20)", -0.4)]))).toBeNull();
    // a coin the Lab cannot name (HIP-3 key) has no rule
    expect(noveltyRule(entry([feat("ret(7)", 0.2)], { coin: "xyz:ABC" }))).toBeNull();
  });

  test("signal: facts headline, direction null, id by coin and bar", () => {
    const s = valid(noveltySignal(entry([feat("funding_z90", 2.4), feat("ret(7)", -0.123), feat("rv5to60", 3.21)])));
    expect(s).toMatchObject({
      id: "novelty:ETH:2026-11-08", source: "novelty", coin: "ETH", direction: null, at: Date.parse("2026-11-09T00:10:00.000Z"), href: null,
      headline: "new extreme 2026-11-08: funding z90 +2.4, 7d ret -12%, rv5to60 3.21",
      ruleText: "ht:funding z(90) ≥ 2 AND ht:price roc(7) < -0.1",
    });
    expect(s.rule?.direction).toBe("short");
  });
});

describe("other sources", () => {
  const rule: Rule = { asset: "BTC", direction: "long", horizonDays: 5, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] };
  const cat = (id: string, r: Rule) => ({ id, name: `rule ${id}`, rule: r }) as unknown as CatalogueEntry;
  test("catalogue rules firing now carry their own rule; not firing or not in the catalogue → nothing", () => {
    const pulse: MarketPulse = {
      asOf: "2026-11-09T12:00:00.000Z", warnings: [],
      assets: [{ asset: "BTC", longActive: 1, longTotal: 2, shortActive: 0, shortTotal: 0, lean: 0.5, rules: [
        { id: "a", name: "rule a", direction: "long", firing: true, text: "" },
        { id: "b", name: "rule b", direction: "long", firing: false, text: "" },
        { id: "gone", name: "gone", direction: "long", firing: true, text: "" },
      ] }],
    };
    const out = ruleSignals(pulse, [cat("a", rule), cat("b", rule)]).map(valid);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "rule:BTC:a", source: "rule", coin: "BTC", direction: "long", rule, href: "/lab/rules/a", at: Date.parse(pulse.asOf) });
    expect(out[0]!.ruleText).toBe("ht:funding z(30) < -1");
  });

  test("opportunity and radar calls have no Lab twin", () => {
    const o = { id: "11111111-1111-4111-8111-111111111111", coin: "SOL", direction: "short", setupKind: "funding_squeeze", status: "ready", score: 2.345, liquidityTier: 1,
      netEdgeBps: 12.4, edgeBasis: "ledger", createdAt: "2026-11-09T10:00:00.000Z" } as Opportunity;
    expect(valid(opportunitySignal(o))).toMatchObject({
      id: `opportunity:SOL:${o.id}`, direction: "short", rule: null, ruleText: null, href: `/feed?id=${o.id}`,
      headline: "funding_squeeze · ready · score 2.35 · tier 1 · net edge +12 bps (ledger)",
    });
    const c = { id: "2026-11-08-1-HYPE", date: "2026-11-08", at: "2026-11-08T13:00:00.000Z", market: "HYPE", stance: "ride", direction: "long", kind: "catalyst",
      thesis: "x", cause_url: "https://a.b", cause_date: "2026-11-08", kill_price: 30, kill_if: "below 30", mark: 33, btc: 100000, rel: { "3": 2.14 }, killed_at: null } as RadarCall;
    expect(valid(radarSignal(c))).toMatchObject({ id: "radar:HYPE:2026-11-08-1-HYPE", coin: "HYPE", direction: "long", rule: null, href: null, headline: "ride long · catalyst · mark 33 · kill 30 · +3d +2.1% vs BTC" });
  });
});
