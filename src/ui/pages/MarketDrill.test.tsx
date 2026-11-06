import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { MarketDrill } from "./MarketDrill";

describe("MarketDrill", () => {
  test("back goes to the MARKET landing; no INTEL cross-link", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/markets/kPEPE"]}>
        <Routes>
          <Route path="/markets/:coin" element={<MarketDrill />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain("← MARKET");
    expect(html).not.toContain("INTEL →");
  });
});
