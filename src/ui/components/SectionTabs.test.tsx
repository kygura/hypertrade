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

describe("hidden tabs", () => {
  const some: SectionTab[] = [{ to: "/a", label: "A" }, { to: "/b", label: "B" }, { to: "/h", label: "H", hidden: true }];
  const el = <SectionTabs label="demo sections" tabs={some} />;
  test("a hidden tab is off the row, and an unknown path still falls back to the first tab", () => {
    for (const p of ["/a", "/b", "/nowhere"]) {
      const btns = buttons(render(p, el));
      expect(btns).toHaveLength(2);
      expect(btns.filter((b) => b.includes('aria-checked="true"'))).toHaveLength(1);
    }
    expect(buttons(render("/b", el))[1]).toContain('aria-checked="true"');
  });
  test("on its own page a hidden tab joins the row as the one checked segment", () => {
    const html = render("/h/1", el);
    const btns = buttons(html);
    expect(btns).toHaveLength(3);
    expect(btns.map((b) => b.includes('aria-checked="true"'))).toEqual([false, false, true]);
    expect(html).toContain(">H<");
  });
});

describe("MarketTabs", () => {
  test("QUEUE MOVES VECTOR; the coin page keeps QUEUE; a hidden page shows its own tab checked", () => {
    const html = render("/markets/HYPE", <MarketTabs />);
    expect(html).toContain('aria-label="market sections"');
    const btns = buttons(html);
    expect(btns).toHaveLength(4);
    expect(btns.map((b) => b.includes('aria-checked="true"'))).toEqual([false, false, false, true]);
    expect(buttons(render("/queue", <MarketTabs />))[0]).toContain('aria-checked="true"');
    const coin = buttons(render("/coin/SOL", <MarketTabs />));
    expect(coin).toHaveLength(3);
    expect(coin[0]).toContain('aria-checked="true"');
    expect(buttons(render("/moves", <MarketTabs />))[1]).toContain('aria-checked="true"');
    expect(buttons(render("/vector", <MarketTabs />))[2]).toContain('aria-checked="true"');
    for (const p of ["/sectors", "/state", "/cycles/eth"]) {
      const hidden = buttons(render(p, <MarketTabs />));
      expect(hidden).toHaveLength(4);
      expect(hidden.map((b) => b.includes('aria-checked="true"'))).toEqual([false, false, false, true]);
    }
    expect(isMarketPath("/queue")).toBe(true);
    expect(isMarketPath("/coin/SOL")).toBe(true);
    expect(isMarketPath("/moves")).toBe(true);
    expect(isMarketPath("/vector")).toBe(true);
    expect(isMarketPath("/sectors")).toBe(true);
    expect(isMarketPath("/marketsx")).toBe(false);
    expect(isMarketPath("/lab/search")).toBe(false);
  });
});
