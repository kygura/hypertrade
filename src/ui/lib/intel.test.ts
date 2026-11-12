import { afterEach, describe, expect, test } from "bun:test";
import { journalTakeaway, REVIEW_THROTTLE_MS, reviewThrottle } from "./intel";

// Review throttle (DESIGN-terminal §1.5): once per tab per 5 min. Bun has no
// sessionStorage, so this also covers the storage-unavailable path.

afterEach(() => reviewThrottle.reset());

describe("reviewThrottle", () => {
  test("posts on first open, holds for 5 minutes, then posts again", () => {
    const t0 = 1_000_000;
    expect(reviewThrottle.shouldPost(t0)).toBe(true);
    reviewThrottle.record(null, t0);
    expect(reviewThrottle.shouldPost(t0 + 60_000)).toBe(false);
    expect(reviewThrottle.shouldPost(t0 + REVIEW_THROTTLE_MS - 1)).toBe(false);
    expect(reviewThrottle.shouldPost(t0 + REVIEW_THROTTLE_MS)).toBe(true);
  });

  test("keeps the last posted brief in memory", () => {
    expect(reviewThrottle.lastBrief()).toBeNull();
    const brief = { id: "b1" } as Parameters<typeof reviewThrottle.record>[0];
    reviewThrottle.record(brief, 5);
    expect(reviewThrottle.lastBrief()).toBe(brief);
  });
});

describe("journalTakeaway", () => {
  const t = (pnlUsd: number, r: number | null, tag: string | null = "breakout", closedAt: string | null = "2026-11-01T00:00:00.000Z") => ({ pnlUsd, r, tag, closedAt });

  test("counts winners, sums net PnL and averages R over trades with a known stop", () => {
    expect(journalTakeaway([t(120, 1.5), t(-40, -1), t(30, null, null), t(-5, null, "scalp", null)], 30)).toBe(
      "3 closed trades in the last 30 days: 2 made money (67%), net +$110 after fees. Mean result +0.25R over the 2 with a known stop. 1 untagged. 1 still open.",
    );
  });

  test("no known stops, only open trades, and an empty window", () => {
    expect(journalTakeaway([t(-12.5, null)], 7)).toBe("1 closed trade in the last 7 days: 0 made money (0%), net −$12.5 after fees. No closed trade has a known stop, so there are no R values.");
    expect(journalTakeaway([t(0, null, null, null)], 7)).toBe("No closed trades in the last 7 days. 1 still open.");
    expect(journalTakeaway([], 90)).toBeNull();
  });
});
