import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Segmented } from "./Segmented";
import { DEFAULT_THEME, THEMES } from "../themes/registry";

// Render-check (react-dom/server, no jsdom), same approach as
// ModelSelector.test.tsx: markup and ARIA only; SSR can't dispatch events.

const TFS = [
  { value: "1H", label: "1H" },
  { value: "1D", label: "1D" },
  { value: "1W", label: "1W" },
] as const;

const radios = (html: string) => html.match(/<button[^>]*>/g) ?? [];

describe("Segmented", () => {
  test("radiogroup with one checked radio per option", () => {
    const html = renderToStaticMarkup(<Segmented label="timeframe" options={TFS} value="1D" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="timeframe"');
    const btns = radios(html);
    expect(btns).toHaveLength(3);
    expect(btns.filter((b) => b.includes('aria-checked="true"'))).toHaveLength(1);
    expect(btns[1]).toContain('aria-checked="true"');
  });

  test("roving tab stop sits on the checked segment, or the first when none is", () => {
    const checked = radios(renderToStaticMarkup(<Segmented label="tf" options={TFS} value="1W" onChange={() => {}} />));
    expect(checked.map((b) => b.match(/tabindex="(-?\d)"/)?.[1])).toEqual(["-1", "-1", "0"]);

    const none = radios(
      renderToStaticMarkup(<Segmented label="tf" options={TFS} value={"4H" as "1H"} onChange={() => {}} />),
    );
    expect(none.map((b) => b.match(/tabindex="(-?\d)"/)?.[1])).toEqual(["0", "-1", "-1"]);
  });

  test("boolean values, tone, title, size and disabled reach the markup", () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="enabled"
        size="md"
        disabled
        options={[
          { value: true, label: "ON", tone: "green", title: "runs on schedule" },
          { value: false, label: "OFF" },
        ]}
        value={true}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("seg--md");
    expect(html).toContain('data-tone="green"');
    expect(html).toContain('title="runs on schedule"');
    expect(radios(html).every((b) => b.includes("disabled"))).toBe(true);
  });

  test("short labels render a mobile and a desktop variant", () => {
    const html = renderToStaticMarkup(
      <Segmented label="theme" options={[{ value: "hyperdash", label: "HYPERDASH", short: "HD" }]} value="hyperdash" onChange={() => {}} />,
    );
    expect(html).toContain('<span class="md:hidden">HD</span>');
    expect(html).toContain('<span class="hidden md:inline">HYPERDASH</span>');
  });
});

describe("theme registry", () => {
  test("Webring is the default and listed first", () => {
    expect(DEFAULT_THEME).toBe("webring");
    expect(THEMES[0]?.id).toBe("webring");
    expect(THEMES.map((t) => t.id).sort()).toEqual(["hyperdash", "hyperion", "tradexyz", "webring"]);
  });
});
