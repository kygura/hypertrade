import { afterEach, describe, expect, test } from "bun:test";
import { REVIEW_THROTTLE_MS, reviewThrottle } from "./intel";

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
