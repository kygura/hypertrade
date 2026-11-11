import { describe, expect, test } from "bun:test";
import { SetupChecklistSchema, type Attention, type LiqProximity, type Positioning } from "../../shared/moves.js";
import { checklists, FADE_LONG_DEFINITION, FADE_SHORT_DEFINITION, type ChecklistInput } from "./checklists.js";

const ok = { state: "ok" as const, reason: null };
const pos = (longMet: number, shortMet: number, of = 4): Positioning => ({
  fundingHourly: 0, fundingAprPct: 0, fundingZ: 0, fundingN: 336, premiumBps: 0, oiUsd: 1, oiChg24hPct: 0, oiChg72hPct: 0, oiN: 10, oiToVolume: 1,
  checks: [], longMet, shortMet, of,
});
const att = (o: Partial<Attention> = {}): Attention => ({ state: ok, news24h: 0, news72h: 0, newsDailyMean7d: 0, newsRatio: 0, mentions24h: null, mentionsChg24hPct: null, mentionsAsOf: null, sectorId: null, sectorStage: null, ...o });
const liq = (o: Partial<LiqProximity> = {}): LiqProximity => ({ state: ok, nearestLong: null, nearestShort: null, sigma24hPct: 5, longSigmas: 0.6, shortSigmas: 2, coverageRatio: 0.4, ...o });
const run = (o: Partial<ChecklistInput> = {}) => checklists({ residual24h: { residualPct: 6, residualZ: 3 }, positioning: pos(0, 0), attention: att(), liq: liq(), ...o });
const metOf = (c: ReturnType<typeof run>[number]) => Object.fromEntries(c.checks.map((x) => [x.key, x.met]));

describe("ENTER", () => {
  test("side from the 24h residual sign; attention rising by news or by mentions; low crowding; |z| ≥ 1.5", () => {
    const [enter] = run({ attention: att({ news24h: 3, newsRatio: 3 }) });
    SetupChecklistSchema.parse(enter);
    expect(enter).toMatchObject({ kind: "enter", side: "long", met: 3, of: 3, definitionId: null });
    const [byMentions] = run({ residual24h: { residualPct: -4, residualZ: -2 }, attention: att({ mentionsChg24hPct: 80 }), positioning: pos(0, 2) });
    expect(byMentions.side).toBe("short");
    expect(metOf(byMentions)).toEqual({ attention_rising: true, crowding_low: false, residual_z: true });
  });

  test("no 24h attribution: no side, residual and crowding checks not evaluable", () => {
    const [enter] = run({ residual24h: null });
    expect(enter.side).toBeNull();
    expect(metOf(enter)).toEqual({ attention_rising: null, crowding_low: null, residual_z: null });
    expect(enter.of).toBe(0);
    // Three-valued: no news and no Elfa sample is unknown; no news and flat mentions is false.
    const [flat] = run({ residual24h: null, attention: att({ mentionsChg24hPct: 5 }) });
    expect(metOf(flat).attention_rising).toBe(false);
  });

  test("attention unknown (no store, no Elfa) is null, not false", () => {
    const [enter] = run({ attention: att({ news24h: null, newsRatio: null, news72h: null, newsDailyMean7d: null, state: { state: "unavailable", reason: "needs a database" } }) });
    expect(metOf(enter).attention_rising).toBeNull();
    expect(enter.of).toBe(2);
  });
});

describe("FADE", () => {
  test("crowded long, saturated attention, a long cluster within 1 σ24h: 3/3, tested as funding_fade", () => {
    const [, fade] = run({ positioning: pos(3, 0), attention: att({ news72h: 6, newsRatio: 0.5 }) });
    SetupChecklistSchema.parse(fade);
    expect(fade).toMatchObject({ kind: "fade", side: "long", met: 3, of: 3, definitionId: "funding_fade" });
    expect(FADE_LONG_DEFINITION).toBe("funding_fade");
    expect(FADE_SHORT_DEFINITION).toBe("negative_funding_build");
  });

  test("crowded short reads the short cluster and maps to negative_funding_build; sector stage counts as saturation", () => {
    const [, fade] = run({ positioning: pos(0, 3), attention: att({ sectorStage: "fading" }), liq: liq({ shortSigmas: 0.9 }) });
    expect(fade).toMatchObject({ side: "short", met: 3, of: 3, definitionId: "negative_funding_build" });
  });

  test("needs coverage ≥ 0.25: a near cluster on a thin map does not pass", () => {
    const [, fade] = run({ positioning: pos(4, 0), attention: att({ sectorStage: "crowded" }), liq: liq({ coverageRatio: 0.1 }) });
    expect(metOf(fade).liq_near).toBe(false);
    expect(fade.met).toBe(2);
  });

  test("no crowded side: side null, the liquidation check not evaluable; no liquidation map: null", () => {
    const [, fade] = run();
    expect(fade).toMatchObject({ side: null, definitionId: null });
    expect(metOf(fade)).toEqual({ crowded: false, attention_saturated: null, liq_near: null });
    const [, quiet] = run({ attention: att({ sectorStage: "quiet" }) });
    expect(metOf(quiet).attention_saturated).toBe(false);
    const [, noMap] = run({ positioning: pos(3, 0), liq: liq({ state: { state: "unavailable", reason: "x" }, coverageRatio: null, longSigmas: null }) });
    expect(metOf(noMap).liq_near).toBeNull();
    expect(noMap.of).toBe(1); // attention unknown too (no sector stage, no news ratio crossing)
  });
});
