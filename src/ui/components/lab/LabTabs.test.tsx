import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { isResearchPath, LabTabs } from "./LabTabs";

// The RESEARCH row in workflow order (docs/RESEARCH.md "Nav"). Rendered without a LabDataProvider, as the
// board does: no Lab load is needed and the pulse dot (PULSE page only) comes from the caller.
const render = (path: string, pulseFiring?: boolean) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <LabTabs pulseFiring={pulseFiring} />
    </MemoryRouter>,
  );
const labels = (html: string) => (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).map((b) => b.replace(/<span class="md:hidden">[^<]*<\/span>/, "").replace(/<[^>]+>/g, "").replace(/ · rule firing/, ""));
const checked = (html: string) => (html.match(/<button[^>]*>/g) ?? []).findIndex((b) => b.includes('aria-checked="true"'));

describe("LabTabs", () => {
  test("BOARD · STUDY · RULES · BRANCHES; SEARCH, RUNS and PULSE are off the row", () => {
    expect(labels(render("/board"))).toEqual(["BOARD", "STUDY", "RULES", "BRANCHES"]);
  });
  test("each route checks its tab; the board is BOARD", () => {
    expect(checked(render("/board"))).toBe(0);
    expect(checked(render("/lab/study"))).toBe(1);
    expect(checked(render("/lab/catalogue"))).toBe(2);
    expect(checked(render("/branches/b1"))).toBe(3);
  });
  test("a hidden page shows its own tab, checked, in workflow position", () => {
    expect(labels(render("/lab/search"))).toEqual(["BOARD", "STUDY", "SEARCH", "RULES", "BRANCHES"]);
    expect(checked(render("/lab/search"))).toBe(2);
    expect(labels(render("/lab/runs/r1"))).toEqual(["BOARD", "STUDY", "SEARCH", "RULES", "BRANCHES"]);
    expect(checked(render("/lab/runs/r1"))).toBe(2);
    expect(labels(render("/lab/runs"))).toEqual(["BOARD", "STUDY", "RUNS", "RULES", "BRANCHES"]);
    expect(checked(render("/lab/runs"))).toBe(2);
    expect(labels(render("/lab/pulse"))).toEqual(["BOARD", "STUDY", "RULES", "PULSE", "BRANCHES"]);
    expect(checked(render("/lab/pulse"))).toBe(3);
  });
  test("the pulse dot shows only on the PULSE page: it follows pulseFiring, unknown is no dot and a neutral title", () => {
    expect(render("/board", true)).not.toContain("bg-green");
    expect(render("/lab/pulse", true)).toContain("bg-green");
    expect(render("/lab/pulse", false)).not.toContain("bg-green");
    expect(render("/lab/pulse", false)).toContain('title="no catalogued rule is firing"');
    const unknown = render("/lab/pulse");
    expect(unknown).toContain('title="pulse not loaded"');
    expect(unknown).not.toContain("inline-block w-1.5 h-1.5");
  });
  test("isResearchPath", () => {
    for (const p of ["/board", "/lab", "/lab/study", "/branches", "/branches/x"]) expect(isResearchPath(p)).toBe(true);
    for (const p of ["/", "/feed", "/labx", "/terminal", "/boardx"]) expect(isResearchPath(p)).toBe(false);
  });
});
