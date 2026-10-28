import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { MarketDrill } from "./MarketDrill";

describe("MarketDrill coin cross-links", () => {
  test("offers INTEL → for the same coin", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/markets/kPEPE"]}>
        <Routes>
          <Route path="/markets/:coin" element={<MarketDrill />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain("INTEL →");
    expect(html).toContain("← MARKETS");
  });
});
