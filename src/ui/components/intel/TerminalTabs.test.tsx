import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TerminalTabs, TERMINAL_TABS, isTerminalPath, terminalTabOf } from "./TerminalTabs";

// Render-check (react-dom/server, no jsdom), same approach as
// Segmented.test.tsx: path mapping plus markup and ARIA only.

describe("terminalTabOf / isTerminalPath", () => {
  test("every family route maps to its tab", () => {
    expect(terminalTabOf("/")).toBe("cockpit");
    expect(terminalTabOf("/terminal")).toBe("terminal");
    expect(terminalTabOf("/asset/HYPE")).toBe("terminal");
    expect(terminalTabOf("/journal")).toBe("journal");
    expect(terminalTabOf("/theses")).toBe("theses");
    expect(terminalTabOf("/query")).toBe("query");
    expect(terminalTabOf("/order")).toBe("order");
    expect(terminalTabOf("/desk")).toBe("desk");
    expect(terminalTabOf("/watch")).toBe("watch");
    expect(terminalTabOf("/journal/")).toBe("journal");
  });

  test("routes outside the family are not terminal paths", () => {
    for (const p of ["/lab/search", "/overview", "/markets", "/markets/HYPE", "/deskx", "/journalx", "/orders", "/strategies", "/login"]) {
      expect(terminalTabOf(p)).toBeNull();
      expect(isTerminalPath(p)).toBe(false);
    }
    for (const t of TERMINAL_TABS) expect(isTerminalPath(t.path)).toBe(true);
  });

  test("short labels stay within 4 chars (DESIGN-terminal §1.3 mobile fit)", () => {
    expect(TERMINAL_TABS.map((t) => t.short)).toEqual(["CHNG", "WTCH", "JRNL", "THES", "QRY", "FEED", "ORDR", "DESK"]);
    for (const t of TERMINAL_TABS) expect(String(t.short).length).toBeLessThanOrEqual(4);
  });
});

describe("TerminalTabs", () => {
  const render = (path: string) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <TerminalTabs />
      </MemoryRouter>,
    );

  test("sticky radiogroup with eight segments, the current route checked", () => {
    const html = render("/theses");
    expect(html).toContain('aria-label="trade sections"');
    expect(html).toContain("sticky top-[var(--topbar-h)]");
    const btns = html.match(/<button[^>]*>/g) ?? [];
    expect(btns).toHaveLength(8);
    const checked = btns.filter((b) => b.includes('aria-checked="true"'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('title="test a thesis against the data"');
  });

  test("tabs run Intel then Act, each route checks its own tab", () => {
    const labels = TERMINAL_TABS.map((t) => t.label);
    expect(labels).toEqual(["CHANGES", "WATCH", "JOURNAL", "THESES", "QUERY", "FEED", "ORDER", "DESK"]);
    const checkedIdx = (path: string) => (render(path).match(/<button[^>]*>/g) ?? []).findIndex((b) => b.includes('aria-checked="true"'));
    expect(checkedIdx("/terminal")).toBe(0);
    expect(checkedIdx("/asset/HYPE")).toBe(0);
    expect(checkedIdx("/watch")).toBe(1);
    expect(checkedIdx("/")).toBe(5);
    expect(checkedIdx("/desk")).toBe(7);
  });
});
