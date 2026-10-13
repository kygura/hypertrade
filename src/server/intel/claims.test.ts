import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ClaimSchema, ObservedClaimSchema } from "../../shared/claims.js";
import { claimsJsonSchema, validateClaims } from "./claims.js";

const observed = { tag: "observed", text: "SOL funding hit 0.04%/h.", source: { label: "snapshot", url: "/markets/SOL" }, ts: "2026-10-13T14:00:00Z" };
const hypothesis = { tag: "hypothesis", text: "Longs look crowded." };

describe("validateClaims", () => {
  test("keeps tagged claims, drops untagged / observed without source or ts / bad ts", () => {
    const { claims, dropped } = validateClaims([
      observed,
      hypothesis,
      { text: "no tag" },
      { tag: "fact", text: "unknown tag" },
      { tag: "observed", text: "no source", ts: observed.ts },
      { tag: "observed", text: "no ts", source: { label: "x" } },
      { ...observed, ts: "yesterday" },
      { ...observed, ts: "2026-10-13" },
      { ...hypothesis, text: "   " },
      { ...hypothesis, source: { label: "extra" } },
      "a bare string",
      null,
    ]);
    expect(claims).toEqual([observed, hypothesis] as any);
    expect(dropped).toBe(10);
  });

  test("accepts an offset timestamp and a source without url", () => {
    const c = { ...observed, source: { label: "Reuters" }, ts: "2026-10-13T14:00:00+02:00" };
    expect(validateClaims([c])).toEqual({ claims: [c as any], dropped: 0 });
  });
});

describe("claimsJsonSchema ↔ ClaimSchema parity", () => {
  const variants = claimsJsonSchema.items.anyOf;
  const required = (shape: z.ZodRawShape) => Object.keys(shape).filter((k) => !shape[k]!.isOptional());

  test("one JSON variant per zod option, same keys, same required set", () => {
    expect(variants.map((v) => v.properties.tag.enum[0]).sort()).toEqual(ClaimSchema.options.map((o) => o.shape.tag.value).sort());
    for (const option of ClaimSchema.options) {
      const v = variants.find((x) => x.properties.tag.enum[0] === option.shape.tag.value)!;
      expect(Object.keys(v.properties).sort()).toEqual(Object.keys(option.shape).sort());
      expect(([...v.required] as string[]).sort()).toEqual(required(option.shape).sort());
      expect(v.additionalProperties).toBe(false);
    }
    const source = variants[0]!.properties as (typeof variants)[0]["properties"];
    const zSource = ObservedClaimSchema.shape.source.shape;
    expect(Object.keys(source.source.properties).sort()).toEqual(Object.keys(zSource).sort());
    expect([...source.source.required] as string[]).toEqual(required(zSource));
  });

  test("length limits match", () => {
    const o = ObservedClaimSchema.shape;
    const max = (s: z.ZodString) => s.maxLength;
    const v = variants[0]!.properties;
    expect(max(o.text)).toBe(v.text.maxLength);
    expect(max(o.source.shape.label)).toBe(v.source.properties.label.maxLength);
    expect(max(o.source.shape.url.unwrap())).toBe(v.source.properties.url.maxLength);
  });
});
