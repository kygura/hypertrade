import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ExposurePosition } from "../../../shared/intel";
import { fmtLeverage } from "./format";
import { PositionsTable } from "./PositionsTable";

// Live run: desk positions report leverage as notional / equity (0.020021928801377955),
// which the table printed verbatim.

const desk: ExposurePosition = {
  id: "desk:SOL", source: "desk", asset: "SOL", side: "long", size: 1.88, entryPx: 106.43, markPx: 106.5, stopPx: 99.18,
  leverage: 0.020021928801377955, venue: "paper", notionalUsd: 200.2, unrealizedPnl: 0.13,
};

describe("PositionsTable leverage", () => {
  test("fmtLeverage rounds to 2 decimals and drops trailing zeros", () => {
    expect(fmtLeverage(0.020021928801377955)).toBe("0.02×");
    expect(fmtLeverage(3)).toBe("3×");
    expect(fmtLeverage(2.5)).toBe("2.5×");
  });

  test("a desk position's float leverage renders rounded", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PositionsTable positions={[desk]} onEdit={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain("0.02×");
    expect(html).not.toContain("0.0200219");
  });
});
