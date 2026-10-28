import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { BranchDetail } from "./BranchDetail";

describe("BranchDetail back link", () => {
  test("offers ← BRANCHES back to the list", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/branches/b1"]}>
        <Routes>
          <Route path="/branches/:id" element={<BranchDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain("← BRANCHES");
  });
});
