import { describe, expect, test } from "bun:test";
import {
  AnswerSchema,
  DecisionRecordSchema,
  DecisionsResponseSchema,
  GovernorSettingsSchema,
  ManifestSchema,
  ManifestsResponseSchema,
  QuestionSchema,
  StrategiesResponseSchema,
  StrategyConfigSchema,
  StrategyStatusSchema,
  VenuesResponseSchema,
  legendText,
} from "./strategy-protocol";
import { coerceParam, defaultParams, validateParams } from "./strategy-params";
import manifest from "./fixtures/strategy/manifest.json";
import manifests from "./fixtures/strategy/manifests.json";
import config from "./fixtures/strategy/config.json";
import governor from "./fixtures/strategy/governor.json";
import decision from "./fixtures/strategy/decision.json";
import decisionDryRun from "./fixtures/strategy/decision-dry-run.json";
import decisions from "./fixtures/strategy/decisions.json";
import strategyStatus from "./fixtures/strategy/strategy-status.json";
import strategies from "./fixtures/strategy/strategies.json";
import venues from "./fixtures/strategy/venues.json";

describe("strategy fixtures parse", () => {
  test("manifest", () => {
    const m = ManifestSchema.parse(manifest);
    expect(m.id).toBe("funding_skew");
    expect(m.params.map((p) => p.type)).toEqual(["number", "number", "enum", "string", "bool"]);
    expect(Object.keys(m.questions)).toEqual(["funding_extreme", "direction", "crowding"]);
  });

  test("manifests envelope", () => {
    expect(ManifestsResponseSchema.parse(manifests).manifests.length).toBe(2);
  });

  test("config", () => {
    const c = StrategyConfigSchema.parse(config);
    expect(c.governor?.min_confidence).toBe(0.75);
    expect(c.governor?.mode).toBeUndefined();
  });

  test("governor", () => {
    expect(GovernorSettingsSchema.parse(governor).mode).toBe("manual");
  });

  test("decision (live) and decision (dry run)", () => {
    const d = DecisionRecordSchema.parse(decision);
    expect(d.dry_run).toBe(false);
    expect(d.intents[0]!.action).toBe("open_short");
    expect(d.verdicts[0]!.status).toBe("proposed");
    const answer = d.answers["crowding"]!;
    expect(answer.type).toBe("score");
    if (answer.type === "score") {
      expect(legendText(answer.legend!["1"])).toBe("somewhat");
      expect(legendText(answer.legend!["0"])).toBe("not crowded");
    }
    const noul = d.answers["funding_extreme"]!;
    expect(noul.type === "noul" && noul.confidence).toBeUndefined();

    const dd = DecisionRecordSchema.parse(decisionDryRun);
    expect(dd.dry_run).toBe(true);
    expect(dd.intents).toEqual([]);
  });

  test("decisions envelope", () => {
    expect(DecisionsResponseSchema.parse(decisions).decisions.length).toBe(2);
  });

  test("strategy status and strategies envelope", () => {
    const s = StrategyStatusSchema.parse(strategyStatus);
    expect(s.config.id).toBe(s.manifest.id);
    const list = StrategiesResponseSchema.parse(strategies).strategies;
    expect(list.length).toBe(2);
    expect(list[1]!.last_error).toMatch(/timeout/);
  });

  test("venues envelope", () => {
    const v = VenuesResponseSchema.parse(venues).venues;
    expect(v[0]!.positions[0]!.size_usd).toBe(-250);
    expect(v[1]!.positions).toEqual([]);
  });
});

describe("Jev primitives", () => {
  test("question union discriminates on type", () => {
    expect(QuestionSchema.parse({ type: "noul", instructions: "x" }).type).toBe("noul");
    expect(() => QuestionSchema.parse({ type: "choice", instructions: "x" })).toThrow();
    expect(() => QuestionSchema.parse({ type: "score", instructions: "x", criteria: { a: "b" } })).toThrow();
  });

  test("noul answer has no confidence; choice answer may", () => {
    const n = AnswerSchema.parse({ type: "noul", noul: 0.5 });
    expect(n.type === "noul" && n.confidence).toBeUndefined();
    const c = AnswerSchema.parse({ type: "choice", choice: "a", probabilities: { a: 1 } });
    expect(c.type === "choice" && c.confidence).toBeUndefined();
  });

  test("unknown fields are ignored", () => {
    const g = GovernorSettingsSchema.parse({ ...governor, future_field: 1 });
    expect("future_field" in g).toBe(false);
  });
});

describe("validateParams", () => {
  const specs = ManifestSchema.parse(manifest).params;

  test("defaults pass", () => {
    expect(validateParams(specs, defaultParams(specs))).toEqual({});
  });

  test("min/max/step/enum are enforced with field-keyed messages", () => {
    const errors = validateParams(specs, {
      size_usd: 5,
      min_p: 0.83,
      side_bias: "sideways",
      note: 4,
      close_on_flip: "yes",
    });
    expect(errors.size_usd).toMatch(/≥ 10/);
    expect(errors.min_p).toMatch(/multiple of 0.05/);
    expect(errors.side_bias).toMatch(/both, long_only, short_only/);
    expect(errors.note).toBe("must be text");
    expect(errors.close_on_flip).toMatch(/true or false/);
  });

  test("max is enforced and NaN is rejected", () => {
    expect(validateParams(specs, { ...defaultParams(specs), size_usd: 200000 }).size_usd).toMatch(/≤ 100000/);
    expect(validateParams(specs, { ...defaultParams(specs), size_usd: Number.NaN }).size_usd).toBe("must be a number");
  });

  test("coerceParam maps raw input strings to runtime types", () => {
    expect(coerceParam(specs[0]!, "250")).toBe(250);
    expect(coerceParam(specs[0]!, "")).toBeNaN();
    expect(coerceParam(specs[4]!, true)).toBe(true);
    expect(coerceParam(specs[2]!, "long_only")).toBe("long_only");
  });
});
