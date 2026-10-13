import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { DiffItem } from "../../../shared/intel";
import { DiffTable, diffColumns } from "./DiffTable";

// Render-check (react-dom/server, no jsdom), same approach as
// Segmented.test.tsx: DESIGN-terminal §3.4 column priorities and markers.

const ts = "2026-10-13T12:00:00.000Z";
const base = { from: 1e9, to: 1.2e9, z: 3.1, exposureWeight: 0.5, stopProximity: 1, ts, baselineTs: "2026-10-13T06:00:00.000Z" };
const oi: DiffItem = { ...base, asset: "HYPE", metric: "oi_usd", held: true, delta: 18.4, deltaUnit: "pct", materiality: 0.71, stopDistPct: 3.1, stopDistAtr: 0.8 };
const px: DiffItem = { ...base, asset: "ETH", metric: "price", held: false, from: 3600, to: 3500, delta: -2.8, deltaUnit: "pct", materiality: 0.11 };

const render = (items: DiffItem[], push?: number) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <DiffTable items={items} pushMateriality={push} />
    </MemoryRouter>,
  );
const headers = (html: string) =>
  (html.match(/<th[^>]*>.*?<\/th>/g) ?? []).map((h) => ({ cls: h.match(/class="([^"]*)"/)?.[1] ?? "", text: h.replace(/<[^>]+>/g, "") }));

describe("DiffTable", () => {
  test("column order and priorities follow §3.4", () => {
    expect(diffColumns().map((c) => [c.label, c.priority])).toEqual([
      ["ASSET", 1],
      ["METRIC", 1],
      ["MAT", 1],
      ["Δ", 2],
      ["Z", 2],
      ["NOW", 3],
      ["STOP", 3],
      ["BASE", 4],
      ["WEIGHT", 4],
    ]);
    const hs = headers(render([oi]));
    const cls = (t: string) => hs.find((h) => h.text === t)!.cls;
    for (const t of ["ASSET", "METRIC", "MAT", "Δ", "Z"]) expect(cls(t)).not.toContain("hidden");
    for (const t of ["NOW", "STOP"]) expect(cls(t)).toContain("hidden md:table-cell");
    for (const t of ["BASE", "WEIGHT"]) expect(cls(t)).toContain("hidden lg:table-cell");
  });

  test("HELD / WATCH marker, server order kept, rows focusable, not sortable", () => {
    const html = render([oi, px]);
    expect(html).toContain(">HELD<");
    expect(html).toContain(">WATCH<");
    expect(html.indexOf("HYPE")).toBeLessThan(html.indexOf("ETH"));
    expect(html.match(/<tr[^>]*tabindex="0"/g) ?? []).toHaveLength(2);
    expect(html).not.toContain("▾");
  });

  test("only price Δ is green/red; MAT amber at the push threshold; stop distance", () => {
    const html = render([oi, px], 0.35);
    expect(html).toContain('<span class="text-text-primary">+18.4%</span>');
    expect(html).toContain('<span class="text-red-text">−2.8%</span>');
    expect(html).toContain('<span class="text-amber">0.71</span>');
    expect(html).toContain('<span class="text-text-primary">0.11</span>');
    expect(html).toContain("z +3.1");
    expect(html).toContain("−3.1% · 0.8×ATR");
    expect(html).toContain('title="0.05 floor"');
  });

  test("non-finite z prints — with the sample note", () => {
    expect(render([{ ...oi, z: Number.NaN }])).toContain('title="fewer than 24 samples"');
  });
});
