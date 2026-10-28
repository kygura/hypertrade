import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SectionTabs, tabMatches, type SectionTab } from "./SectionTabs";
import { MarketTabs, isMarketPath } from "./market/MarketTabs";

const tabs: SectionTab[] = [
  { to: "/a", label: "A" },
  { to: "/b", label: "B · 3", short: "B", match: (p) => p.startsWith("/b") || p === "/x" },
  { to: "/c", label: "C", dot: true },
  { to: "/d", label: "D", dot: false },
];
const render = (path: string, el = <SectionTabs label="demo sections" tabs={tabs} />) =>
  renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>);
const buttons = (html: string) => html.match(/<button[^>]*>/g) ?? [];

describe("SectionTabs", () => {
  test("sticky radiogroup, one segment per tab, current route checked", () => {
    const html = render("/b/1");
    expect(html).toContain('aria-label="demo sections"');
    expect(html).toContain("sticky top-[var(--topbar-h)]");
    expect(html).toContain("h-[var(--subnav-h)]");
    const btns = buttons(html);
    expect(btns).toHaveLength(4);
    expect(btns.filter((b) => b.includes('aria-checked="true"'))).toHaveLength(1);
    expect(btns[1]).toContain('aria-checked="true"');
  });

  test("custom match wins, default matches prefix, unknown path falls back to the first tab", () => {
    expect(buttons(render("/x"))[1]).toContain('aria-checked="true"');
    expect(buttons(render("/a/deep"))[0]).toContain('aria-checked="true"');
    expect(buttons(render("/nowhere"))[0]).toContain('aria-checked="true"');
    expect(tabMatches(tabs[0]!, "/ab")).toBe(false);
  });

  test("dynamic label and dot: green when true, dim when false, none when omitted", () => {
    const html = render("/a");
    expect(html).toContain("B · 3");
    expect(html).toContain("bg-green");
    expect(html).toContain("bg-text-secondary/40");
    expect(html.match(/inline-block w-1\.5 h-1\.5/g)).toHaveLength(2);
  });
});

describe("MarketTabs", () => {
  test("PERPS SECTORS STATE CYCLES; drills keep their tab", () => {
    const html = render("/cycles/eth", <MarketTabs />);
    expect(html).toContain('aria-label="market sections"');
    const btns = buttons(html);
    expect(btns).toHaveLength(4);
    expect(btns[3]).toContain('aria-checked="true"');
    expect(buttons(render("/markets/HYPE", <MarketTabs />))[0]).toContain('aria-checked="true"');
    expect(isMarketPath("/sectors")).toBe(true);
    expect(isMarketPath("/marketsx")).toBe(false);
    expect(isMarketPath("/lab/search")).toBe(false);
  });
});
