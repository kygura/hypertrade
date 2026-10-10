import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS, buildCatalog, parseOpenAIModels } from "./catalog.js";
import { DEFAULT_MODEL, resolveChosenProvider, resolveProvider } from "./provider.js";

// Catalog availability/precedence logic (SPEC.md "Analyst" model selector).
// See README.md's "Analyst" section for the plain-English precedence rules
// this exercises.

describe("buildCatalog", () => {
  test("nothing configured: both providers unavailable with reasons, 200-able shape", () => {
    const cat = buildCatalog({});
    expect(cat.default).toEqual({ provider: "anthropic", model: DEFAULT_MODEL });
    expect(cat.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "google", "xai", "deepseek", "moonshot", "qwen", "openrouter", "openai-compatible"]);
    expect(cat.providers.every((p) => !p.available && p.reason)).toBe(true);
    const anthropic = cat.providers.find((p) => p.id === "anthropic")!;
    expect(anthropic.available).toBe(false);
    expect(anthropic.reason).toBe("set ANTHROPIC_API_KEY or ANALYST_ANTHROPIC_API_KEY");
    expect(anthropic.models).toEqual(ANTHROPIC_MODELS);
    const openai = cat.providers.find((p) => p.id === "openai-compatible")!;
    expect(openai.available).toBe(false);
    expect(openai.reason).toBe("set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL");
    expect(openai.models).toEqual([]);
  });

  test("legacy single-provider config: ANALYST_API_KEY configures the default provider only", () => {
    const anthropicDefault = buildCatalog({ ANALYST_API_KEY: "k", DESK_ANALYST_MODEL: "claude-fable-5-1" });
    expect(anthropicDefault.default).toEqual({ provider: "anthropic", model: "claude-fable-5-1" });
    expect(anthropicDefault.providers.find((p) => p.id === "anthropic")!.available).toBe(true);
    expect(anthropicDefault.providers.find((p) => p.id === "openai-compatible")!.available).toBe(false);

    const openaiDefault = buildCatalog({
      ANALYST_PROVIDER: "openai-compatible",
      ANALYST_API_KEY: "k",
      ANALYST_BASE_URL: "http://llm.local/v1",
      DESK_ANALYST_MODEL: "local-model",
    });
    expect(openaiDefault.default).toEqual({ provider: "openai-compatible", model: "local-model" });
    expect(openaiDefault.providers.find((p) => p.id === "openai-compatible")!.available).toBe(true);
    expect(openaiDefault.providers.find((p) => p.id === "openai-compatible")!.models).toEqual([
      { id: "local-model", label: "local-model", note: "From ANALYST_MODELS/DESK_ANALYST_MODEL — capabilities unknown for this endpoint", tier: "balanced", effort: false },
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
  test("ANALYST_MODELS takes precedence over DESK_ANALYST_MODEL", () => {
    expect(parseOpenAIModels({ ANALYST_MODELS: "a,b=B", DESK_ANALYST_MODEL: "c" }).map((m) => m.id)).toEqual(["a", "b"]);
  });
  test("no ANALYST_MODELS + not the default provider → empty (DESK_ANALYST_MODEL belongs to the default)", () => {
    expect(parseOpenAIModels({ ANALYST_PROVIDER: "anthropic", DESK_ANALYST_MODEL: "c" })).toEqual([]);
  });
});

describe("resolveChosenProvider", () => {
  test("builds anthropic with the requested model/effort regardless of ANALYST_PROVIDER", () => {
    const p = resolveChosenProvider(
      { ANALYST_PROVIDER: "openai-compatible", ANALYST_ANTHROPIC_API_KEY: "k" },
      { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" },
    )!;
    expect(p.id).toBe("anthropic");
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.effort).toBe("low");
    // Haiku 4.5 takes no effort level: none is in force whatever was asked.
    expect(resolveChosenProvider({ ANALYST_ANTHROPIC_API_KEY: "k" }, { provider: "anthropic", model: "claude-haiku-4-5", effort: "low" })!.effort).toBeUndefined();
  });

  test("builds a vendor preset from its standard key var, clamping effort to the model's levels", () => {
    const p = resolveChosenProvider({ MOONSHOT_API_KEY: "k" }, { provider: "moonshot", model: "kimi-k3", effort: "medium" })!;
    expect(p.id).toBe("moonshot");
    expect(p.label).toBe("Moonshot Kimi");
    expect(p.webSearch).toBe(false);
    expect(p.effort).toBe("high"); // medium isn't a K3 level → the model default
    expect(resolveChosenProvider({ MOONSHOT_API_KEY: "k" }, { provider: "moonshot", model: "kimi-k2.6" })!.effort).toBeUndefined();
  });
  test("null when the chosen provider has no credentials", () => {
    expect(resolveChosenProvider({}, { provider: "anthropic", model: "claude-sonnet-5-5" })).toBeNull();
    expect(resolveChosenProvider({}, { provider: "moonshot", model: "kimi-k3" })).toBeNull();
    expect(resolveChosenProvider({ ANALYST_OPENAI_API_KEY: "k" }, { provider: "openai-compatible", model: "m" })).toBeNull(); // no base URL
  });
});

describe("vendor presets", () => {
  test("a preset is available from its standard key var, with its curated models", () => {
    const cat = buildCatalog({ DEEPSEEK_API_KEY: "k", OPENAI_API_KEY: "k2" });
    const ds = cat.providers.find((p) => p.id === "deepseek")!;
    expect(ds.available).toBe(true);
    expect(ds.models.map((m) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);
    expect(ds.models[0]!.efforts).toEqual(["low", "high", "max"]);
    expect(cat.providers.find((p) => p.id === "openai")!.models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(cat.providers.find((p) => p.id === "qwen")!.reason).toBe("set DASHSCOPE_API_KEY");
  });

  test("ANALYST_<PRESET>_MODELS replaces the curated list; OpenRouter needs one", () => {
    const cat = buildCatalog({ OPENROUTER_API_KEY: "k", ANALYST_QWEN_API_KEY: "q", ANALYST_QWEN_MODELS: "qwen-custom=Custom" });
    expect(cat.providers.find((p) => p.id === "qwen")!.models.map((m) => [m.id, m.label])).toEqual([["qwen-custom", "Custom"]]);
    const or = cat.providers.find((p) => p.id === "openrouter")!;
    expect(or.available).toBe(false);
    expect(or.reason).toBe("set ANALYST_OPENROUTER_MODELS");
  });

  test("ANALYST_PROVIDER can name a preset: it becomes the default and takes the legacy ANALYST_API_KEY", () => {
    const env = { ANALYST_PROVIDER: "kimi", ANALYST_API_KEY: "k" };
    const cat = buildCatalog(env);
    expect(cat.default).toEqual({ provider: "moonshot", model: "kimi-k3" });
    expect(cat.providers.find((p) => p.id === "moonshot")!.available).toBe(true);
    expect(cat.providers.find((p) => p.id === "anthropic")!.available).toBe(false);
    const p = resolveProvider(env)!;
    expect([p.id, p.model]).toEqual(["moonshot", "kimi-k3"]);
  });

  test("\"openai\" keeps meaning the generic slot; OpenAI's own platform is openai-platform", () => {
    expect(buildCatalog({ ANALYST_PROVIDER: "openai" }).default.provider).toBe("openai-compatible");
    expect(buildCatalog({ ANALYST_PROVIDER: "openai-platform", OPENAI_API_KEY: "k" }).default).toEqual({ provider: "openai", model: "gpt-6-astra" });
  });
});
