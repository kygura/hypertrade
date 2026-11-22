import { describe, expect, test } from "bun:test";
import { barTouch } from "./firstTouch.js";

describe("barTouch", () => {
  test("stop wins when both levels are inside one bar, and is flagged ambiguous", () => {
    expect(barTouch(1, 98, 104, { o: 100, h: 105, l: 97 })).toEqual({ exit: "stop", px: 98, ambiguous: true });
    expect(barTouch(-1, 102, 96, { o: 100, h: 103, l: 95 })).toEqual({ exit: "stop", px: 102, ambiguous: true });
  });
  test("a gap through the stop fills at the open; a target fills at the target; neither is null", () => {
    expect(barTouch(1, 98, 104, { o: 97, h: 97.5, l: 96 })).toEqual({ exit: "stop", px: 97, ambiguous: false });
    expect(barTouch(-1, 102, 96, { o: 103, h: 104, l: 102.5 })).toEqual({ exit: "stop", px: 103, ambiguous: false });
    expect(barTouch(1, 98, 104, { o: 100, h: 104, l: 99 })).toEqual({ exit: "target", px: 104, ambiguous: false });
    expect(barTouch(1, 98, 104, { o: 100, h: 103, l: 99 })).toBeNull();
    expect(barTouch(1, 98, null, { o: 100, h: 1e9, l: 99 })).toBeNull();
  });
});
