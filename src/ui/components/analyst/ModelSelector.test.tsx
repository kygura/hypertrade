import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSelector } from "./ModelSelector";
import type { AnalystCatalog } from "../../lib/analyst";

// Render-check (react-dom/server, no jsdom): asserts key strings and ARIA
// roles for the selector's closed/open/unavailable/effort-visible states.
// Interaction (click-outside, keyboard nav) is covered by hand-reading the
// component; SSR can't dispatch DOM events, so this only checks markup.

const CATALOG: AnalystCatalog = {
  default: { provider: "anthropic", model: "claude-sonnet-5" },
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      available: true,
      models: [
        { id: "claude-fable-5-1", label: "Fable 5.1", note: "Most capable", tier: "frontier", effort: true },
        { id: "claude-sonnet-5", label: "Sonnet 5", note: "Balanced daily driver", tier: "balanced", effort: true },
        { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "Fast, cheap lookups", tier: "fast", effort: false },
      ],
    },
    {
      id: "openai-compatible",
      label: "OpenAI-compatible",
      available: false,
      reason: "set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL",
      models: [],
    },
  ],
};

const UNAVAILABLE_CATALOG: AnalystCatalog = {
  default: { provider: "anthropic", model: "claude-sonnet-5" },
  providers: [
    { id: "anthropic", label: "Anthropic", available: false, reason: "set ANALYST_ANTHROPIC_API_KEY", models: CATALOG.providers[0]!.models },
    { id: "openai-compatible", label: "OpenAI-compatible", available: false, reason: "set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL", models: [] },
  ],
};

describe("ModelSelector render states", () => {
  test("closed: trigger pill shows provider/model/tier, no listbox markup", () => {
    const html = renderToStaticMarkup(
      <ModelSelector catalog={CATALOG} value={{ provider: "anthropic", model: "claude-sonnet-5", effort: "medium" }} onChange={() => {}} open={false} />,
    );
    expect(html).toContain("Anthropic");
    expect(html).toContain("Sonnet 5");
    expect(html).toContain("BALANCED");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
    // Effort control shows too (Sonnet 5 supports it).
    expect(html).toContain('role="radiogroup"');
  });

  test("open: listbox with provider groups and options, current model checked", () => {
    const html = renderToStaticMarkup(
      <ModelSelector catalog={CATALOG} value={{ provider: "anthropic", model: "claude-sonnet-5", effort: "medium" }} onChange={() => {}} open={true} />,
    );
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="group"');
    // Every model in the catalog is offered as an option.
    expect(html).toContain('role="option"');
    expect(html).toContain("Fable 5.1");
    expect(html).toContain("Haiku 4.5");
    // The selected option is marked aria-selected and carries the check glyph.
    expect(html).toMatch(/aria-selected="true"[^]*?✓/);
    // The unavailable provider is present but dimmed with its reason.
    expect(html).toContain("OpenAI-compatible");
    expect(html).toContain("set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL");
  });

  test("unavailable: no provider configured → pill reads NO PROVIDER with a reason, no effort control", () => {
    const html = renderToStaticMarkup(<ModelSelector catalog={UNAVAILABLE_CATALOG} value={null} onChange={() => {}} open={false} />);
    expect(html).toContain("NO PROVIDER");
    expect(html).toContain("set ANALYST_ANTHROPIC_API_KEY");
    expect(html).toContain("set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL");
    expect(html).not.toContain('role="radiogroup"');
  });

  test("effort-visible only for a model that supports it", () => {
    const withEffort = renderToStaticMarkup(
      <ModelSelector catalog={CATALOG} value={{ provider: "anthropic", model: "claude-fable-5-1", effort: "high" }} onChange={() => {}} />,
    );
    expect(withEffort).toContain('role="radiogroup"');
    for (const lvl of ["low", "medium", "high", "xhigh", "max"]) expect(withEffort).toContain(lvl);
    expect(withEffort).toContain('aria-checked="true"');

    const withoutEffort = renderToStaticMarkup(
      <ModelSelector catalog={CATALOG} value={{ provider: "anthropic", model: "claude-haiku-4-5" }} onChange={() => {}} />,
    );
    expect(withoutEffort).not.toContain('role="radiogroup"');
  });

  test("loading: catalog null renders a skeleton pill, nothing else", () => {
    const html = renderToStaticMarkup(<ModelSelector catalog={null} value={null} onChange={() => {}} />);
    expect(html).toContain('data-testid="model-selector-skeleton"');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("NO PROVIDER");
  });

  test("no effort control when unconfigured, even if `value` still names a real (but unavailable) model", () => {
    // Regression: the caller's last-resort fallback (nothing configured at
    // all) can still pass a `value` naming a model that exists in the
    // catalog but whose provider is unavailable — that must never surface
    // the effort control next to "NO PROVIDER".
    const html = renderToStaticMarkup(
      <ModelSelector catalog={UNAVAILABLE_CATALOG} value={{ provider: "anthropic", model: "claude-sonnet-5", effort: "medium" }} onChange={() => {}} />,
    );
    expect(html).toContain("NO PROVIDER");
    expect(html).not.toContain('role="radiogroup"');
  });

  test("mobile stacked layout: the root wrapper and effort control carry the flex-col/md:flex-row responsive classes", () => {
    const html = renderToStaticMarkup(
      <ModelSelector catalog={CATALOG} value={{ provider: "anthropic", model: "claude-fable-5-1", effort: "high" }} onChange={() => {}} />,
    );
    // Root wrapper: column (full-width pill row, then effort row) on
    // mobile; the original single inline row from md: up.
    const rootClass = html.match(/^<div class="([^"]*)"/)?.[1] ?? "";
    for (const cls of ["flex-col", "items-start", "w-full", "md:flex-row", "md:items-center", "md:w-auto"]) {
      expect(rootClass.split(" ")).toContain(cls);
    }
    // The trigger pill itself never wraps its label, and is full-width
    // below md so it gets its own row.
    expect(html).toMatch(/class="[^"]*\bwhitespace-nowrap\b[^"]*"/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\bw-full\b[^"]*\bmd:w-auto\b[^"]*"/);
    // The model label truncates instead of wrapping onto a second line.
    expect(html).toMatch(/class="[^"]*\btruncate\b[^"]*">Fable 5\.1</);
  });
});
