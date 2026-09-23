import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS, buildCatalog, parseOpenAIModels } from "./catalog";
import { DEFAULT_MODEL, resolveChosenProvider } from "./provider";

// Catalog availability/precedence logic (SPEC.md "Analyst" model selector).
// See README.md's "Analyst" section for the plain-English precedence rules
// this exercises.

describe("buildCatalog", () => {
  test("nothing configured: both providers unavailable with reasons, 200-able shape", () => {
    const cat = buildCatalog({});
    expect(cat.default).toEqual({ provider: "anthropic", model: DEFAULT_MODEL });
    expect(cat.providers.map((p) => p.id)).toEqual(["anthropic", "openai-compatible"]);
    const anthropic = cat.providers.find((p) => p.id === "anthropic")!;
    expect(anthropic.available).toBe(false);
    expect(anthropic.reason).toBe("set ANALYST_ANTHROPIC_API_KEY");
    expect(anthropic.models).toEqual(ANTHROPIC_MODELS);
    const openai = cat.providers.find((p) => p.id === "openai-compatible")!;
    expect(openai.available).toBe(false);
    expect(openai.reason).toBe("set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL");
    expect(openai.models).toEqual([]);
  });

  test("legacy single-provider config: ANALYST_API_KEY configures the default provider only", () => {
    const anthropicDefault = buildCatalog({ ANALYST_API_KEY: "k", ANALYST_MODEL: "claude-fable-5-1" });
    expect(anthropicDefault.default).toEqual({ provider: "anthropic", model: "claude-fable-5-1" });
    expect(anthropicDefault.providers.find((p) => p.id === "anthropic")!.available).toBe(true);
    expect(anthropicDefault.providers.find((p) => p.id === "openai-compatible")!.available).toBe(false);

    const openaiDefault = buildCatalog({
      ANALYST_PROVIDER: "openai-compatible",
      ANALYST_API_KEY: "k",
      ANALYST_BASE_URL: "http://llm.local/v1",
      ANALYST_MODEL: "local-model",
    });
    expect(openaiDefault.default).toEqual({ provider: "openai-compatible", model: "local-model" });
    expect(openaiDefault.providers.find((p) => p.id === "openai-compatible")!.available).toBe(true);
    expect(openaiDefault.providers.find((p) => p.id === "openai-compatible")!.models).toEqual([
      { id: "local-model", label: "local-model", note: "From ANALYST_MODELS/ANALYST_MODEL — capabilities unknown for this endpoint", tier: "balanced", effort: false },
    ]);
    // The legacy ANALYST_API_KEY belongs to the default provider only.
    expect(openaiDefault.providers.find((p) => p.id === "anthropic")!.available).toBe(false);
  });

  test("both providers configured at once via provider-specific vars", () => {
    const cat = buildCatalog({
      ANALYST_PROVIDER: "anthropic",
      ANALYST_API_KEY: "anthropic-key", // the default provider's legacy key
      ANALYST_OPENAI_API_KEY: "openai-key",
      ANALYST_OPENAI_BASE_URL: "http://llm.local/v1",
      ANALYST_MODELS: "m1,m2=Local Two",
    });
    expect(cat.providers.find((p) => p.id === "anthropic")!.available).toBe(true);
    const openai = cat.providers.find((p) => p.id === "openai-compatible")!;
    expect(openai.available).toBe(true);
    expect(openai.models.map((m) => [m.id, m.label])).toEqual([
      ["m1", "m1"],
      ["m2", "Local Two"],
    ]);
  });

  test("ANALYST_ANTHROPIC_API_KEY configures anthropic even when it is not the default provider", () => {
    const cat = buildCatalog({
      ANALYST_PROVIDER: "openai-compatible",
      ANALYST_OPENAI_API_KEY: "k",
      ANALYST_OPENAI_BASE_URL: "http://llm.local/v1",
      ANALYST_ANTHROPIC_API_KEY: "secondary-key",
    });
    expect(cat.default.provider).toBe("openai-compatible");
    expect(cat.providers.find((p) => p.id === "anthropic")!.available).toBe(true);
  });

  test("openai-compatible missing only the base URL reports that reason alone", () => {
    const cat = buildCatalog({ ANALYST_OPENAI_API_KEY: "k" });
    expect(cat.providers.find((p) => p.id === "openai-compatible")!.reason).toBe("set ANALYST_OPENAI_BASE_URL");
  });

  test("unrecognised ANALYST_PROVIDER leaves the legacy vars unclaimed by either provider", () => {
    const cat = buildCatalog({ ANALYST_PROVIDER: "mystery", ANALYST_API_KEY: "k", ANALYST_BASE_URL: "http://x" });
    expect(cat.providers.find((p) => p.id === "anthropic")!.available).toBe(false);
    expect(cat.providers.find((p) => p.id === "openai-compatible")!.available).toBe(false);
  });
});

describe("parseOpenAIModels", () => {
  test("ANALYST_MODELS takes precedence over ANALYST_MODEL", () => {
    expect(parseOpenAIModels({ ANALYST_MODELS: "a,b=B", ANALYST_MODEL: "c" }).map((m) => m.id)).toEqual(["a", "b"]);
  });
  test("no ANALYST_MODELS + not the default provider → empty (ANALYST_MODEL belongs to the default)", () => {
    expect(parseOpenAIModels({ ANALYST_PROVIDER: "anthropic", ANALYST_MODEL: "c" })).toEqual([]);
  });
});

describe("resolveChosenProvider", () => {
  test("builds anthropic with the requested model/effort regardless of ANALYST_PROVIDER", () => {
    const p = resolveChosenProvider(
      { ANALYST_PROVIDER: "openai-compatible", ANALYST_ANTHROPIC_API_KEY: "k" },
      { provider: "anthropic", model: "claude-haiku-4-5", effort: "low" },
    )!;
    expect(p.id).toBe("anthropic");
    expect(p.model).toBe("claude-haiku-4-5");
    expect(p.effort).toBe("low");
  });
  test("null when the chosen provider has no credentials", () => {
    expect(resolveChosenProvider({}, { provider: "anthropic", model: "claude-sonnet-5" })).toBeNull();
    expect(resolveChosenProvider({ ANALYST_OPENAI_API_KEY: "k" }, { provider: "openai-compatible", model: "m" })).toBeNull(); // no base URL
  });
});
