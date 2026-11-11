import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { isResearchPath, LabTabs } from "./LabTabs";

// The RESEARCH row in workflow order (docs/RESEARCH.md "Nav"). Rendered without a LabDataProvider, as the
// board does: no Lab load is needed and the pulse dot comes from the caller.
const render = (path: string, pulseFiring?: boolean) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <LabTabs pulseFiring={pulseFiring} />
    </MemoryRouter>,
  );
const labels = (html: string) => (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).map((b) => b.replace(/<span class="md:hidden">[^<]*<\/span>/, "").replace(/<[^>]+>/g, "").replace(/ · rule firing/, ""));
const checked = (html: string) => (html.match(/<button[^>]*>/g) ?? []).findIndex((b) => b.includes('aria-checked="true"'));

describe("LabTabs", () => {
  test("BOARD · STUDY · SEARCH · RUNS · CATALOGUE · PULSE · BRANCHES", () => {
    expect(labels(render("/"))).toEqual(["BOARD", "STUDY", "SEARCH", "RUNS", "CATALOGUE", "PULSE", "BRANCHES"]);
  });
  test("each route checks its tab; the board is BOARD, not SEARCH", () => {
    expect(checked(render("/"))).toBe(0);
    expect(checked(render("/lab/study"))).toBe(1);
    expect(checked(render("/lab/search"))).toBe(2);
    expect(checked(render("/lab/runs/r1"))).toBe(2);
    expect(checked(render("/lab/runs"))).toBe(3);
    expect(checked(render("/lab/pulse"))).toBe(5);
    expect(checked(render("/branches/b1"))).toBe(6);
  });
  test("outside a provider the pulse dot follows pulseFiring; unknown is no dot and a neutral title", () => {
    expect(render("/", true)).toContain("bg-green");
    expect(render("/", false)).not.toContain("bg-green");
    expect(render("/", false)).toContain('title="no catalogued rule is firing"');
    const unknown = render("/");
    expect(unknown).toContain('title="pulse not loaded"');
    expect(unknown).not.toContain("inline-block w-1.5 h-1.5");
  });
  test("isResearchPath", () => {
    for (const p of ["/", "/lab", "/lab/study", "/branches", "/branches/x"]) expect(isResearchPath(p)).toBe(true);
    for (const p of ["/feed", "/labx", "/terminal"]) expect(isResearchPath(p)).toBe(false);
  });
});
