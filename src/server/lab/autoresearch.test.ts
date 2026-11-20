import { describe, expect, test } from "bun:test";
import { champions, decide, finalReport, KEEP_MARGIN, parseTsv, rowOf, runExperiment, slotOf, toTsv, TSV_HEADER, type Experiment, type Row } from "./autoresearch.js";
import { synthetic } from "./engine/testkit.js";
import type { Rule } from "./types.js";

const planted: Rule = { asset: "SYN", direction: "long", horizonDays: 1, conditions: [{ feature: "syn:a|z|30", op: "<", threshold: -1 }, { feature: "syn:b|raw|0", op: ">=", threshold: 0 }] };
const noise: Rule = { asset: "SYN", direction: "long", horizonDays: 1, conditions: [{ feature: "syn:d|raw|0", op: ">=", threshold: 0.5 }] };
const data = synthetic({ seed: 11, drift: 0.012 });
const exp = (score: number, id = `r${score}`): Experiment => ({ ...runExperiment(planted, data), id, fitness: { ...runExperiment(planted, data).fitness, score } });

describe("autoresearch evaluator (docs/AUTORESEARCH.md)", () => {
  test("an experiment shows walk-forward numbers and nothing of the holdout", () => {
    const e = runExperiment(planted, data);
    expect(e.fitness.score).toBeGreaterThan(1);
    expect(e.invalid).toBeUndefined();
    const text = JSON.stringify(e);
    expect(text).not.toContain("holdout");
    expect(text).not.toContain("inSample");
    // The walk-forward ends where the holdout (last 20%) begins.
    const holdoutFrom = new Date(data.t[data.t.length - Math.floor(data.t.length * 0.2)]!).toISOString().slice(0, 10);
    expect(e.walkForward.to < holdoutFrom).toBe(true);
  });

  test("a rule that never trades in the walk-forward is invalid, not a zero", () => {
    const never = runExperiment({ ...planted, conditions: [{ feature: "syn:b|raw|0", op: ">=", threshold: 99 }] }, data);
    expect(never.invalid).toContain("never trades");
    expect(decide(never, "SYN/long/x", []).status).toBe("invalid");
  });

  test("keep only above zero and above the slot's best by more than the margin; a repeat is discarded", () => {
    const slot = slotOf(planted, "onchain");
    expect(slot).toBe("SYN/long/onchain");
    const rows: Row[] = [];
    expect(decide(exp(-0.2), slot, rows).status).toBe("discard");
    const first = exp(1);
    expect(decide(first, slot, rows).status).toBe("keep");
    rows.push(rowOf(first, planted, slot, "keep", "first"));
    expect(decide(exp(1 + KEEP_MARGIN), slot, rows).status).toBe("discard");
    expect(decide(exp(1 + KEEP_MARGIN + 0.01), slot, rows).status).toBe("keep");
    expect(decide(exp(5, first.id), slot, rows)).toEqual({ status: "discard", why: "already tried" });
    // Another slot starts from nothing.
    expect(decide(exp(0.3), "SYN/short/onchain", rows).status).toBe("keep");
  });

  test("the log round-trips and the champion is the last kept row of a slot", () => {
    const a = rowOf(exp(1, "a"), planted, "SYN/long/x", "keep", "tabs\tand\nnewlines");
    const b = rowOf(exp(0.5, "b"), noise, "SYN/long/x", "discard", "worse");
    const c = rowOf(exp(1.4, "c"), noise, "SYN/long/x", "keep", "better");
    const text = [TSV_HEADER.join("\t"), toTsv(a), toTsv(b), toTsv(c)].join("\n") + "\n";
    const back = parseTsv(text);
    expect(back.map((r) => [r.id, r.status])).toEqual([["a", "keep"], ["b", "discard"], ["c", "keep"]]);
    expect(back[0]!.rule).toEqual(planted);
    expect(back[0]!.description).toBe("tabs and newlines");
    expect(champions(back).map((r) => r.id)).toEqual(["c"]);
  });

  test("the final report reads the holdout once, deflates by every experiment, and carries a stance and a projection", () => {
    const rows = [rowOf(runExperiment(planted, data), planted, "SYN/long/x", "keep", "planted"), rowOf(runExperiment(noise, data), noise, "SYN/long/x", "discard", "noise")];
    const r = finalReport("SYN", rows, data, { horizonDays: 20, paths: 200 });
    expect(r.experiments).toBe(2);
    expect(r.champions).toHaveLength(1);
    const ev = r.champions[0]!.evaluation;
    expect(ev.holdout!.days).toBeGreaterThan(400);
    expect(ev.sensitivity).toBeDefined();
    const one = finalReport("SYN", rows.slice(0, 1), data, { horizonDays: 20, paths: 200 }).champions[0]!.evaluation.deflatedSharpe!;
    expect(ev.deflatedSharpe!).toBeLessThanOrEqual(one);
    expect(["long", "flat"]).toContain(r.stance.side);
    expect(r.stance.long.total).toBe(1);
    expect(r.projection.fan).toHaveLength(21);
  });
});
