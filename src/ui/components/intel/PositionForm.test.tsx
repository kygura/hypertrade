import { describe, expect, test } from "bun:test";
import type { ExposurePosition } from "../../../shared/intel";
import { draftFrom, EMPTY_DRAFT, validatePosition, type PositionDraft } from "./PositionForm";

// PositionForm client validation (DESIGN-terminal §3.7). The server's 400 is
// still the authority and renders verbatim.

const ok: PositionDraft = { ...EMPTY_DRAFT, asset: "SOL", size: "10", entry: "150", stop: "140", leverage: "3" };
const err = (d: PositionDraft) => {
  const r = validatePosition(d);
  return "error" in r ? r.error : null;
};

describe("validatePosition", () => {
  test("a valid long builds the request body", () => {
    expect(validatePosition(ok)).toEqual({ input: { asset: "SOL", side: "long", size: 10, entryPx: 150, stopPx: 140, leverage: 3, venue: "manual" } });
  });

  test("stop is optional; blank leverage defaults to 1, blank venue to manual", () => {
    expect(validatePosition({ ...ok, stop: "", leverage: "", venue: " " })).toEqual({
      input: { asset: "SOL", side: "long", size: 10, entryPx: 150, leverage: 1, venue: "manual" },
    });
  });

  test("size must be above 0", () => {
    for (const size of ["", "0", "-1", "abc"]) expect(err({ ...ok, size })).toBe("size must be above 0");
  });

  test("stop on the wrong side of entry, per side", () => {
    expect(err({ ...ok, stop: "160" })).toBe("stop is on the wrong side of entry for a LONG");
    expect(err({ ...ok, stop: "150" })).toBe("stop is on the wrong side of entry for a LONG");
    expect(err({ ...ok, side: "short", stop: "140" })).toBe("stop is on the wrong side of entry for a SHORT");
    expect(err({ ...ok, side: "short", stop: "160" })).toBeNull();
  });

  test("asset, entry and leverage bounds", () => {
    expect(err({ ...ok, asset: "  " })).toBe("enter an asset");
    expect(err({ ...ok, entry: "0" })).toBe("entry must be above 0");
    expect(err({ ...ok, leverage: "51" })).toBe("leverage must be 1–50");
    expect(err({ ...ok, leverage: "0.5" })).toBe("leverage must be 1–50");
  });
});

describe("draftFrom", () => {
  test("prefills an edit from the position row", () => {
    const p: ExposurePosition = {
      id: "m1",
      source: "manual",
      asset: "SOL",
      side: "short",
      size: 2,
      entryPx: 150,
      markPx: 151,
      stopPx: null,
      leverage: 2,
      venue: "manual",
      notionalUsd: 302,
      unrealizedPnl: -2,
    };
    expect(draftFrom(p)).toEqual({ asset: "SOL", side: "short", size: "2", entry: "150", stop: "", leverage: "2", venue: "manual" });
  });
});
