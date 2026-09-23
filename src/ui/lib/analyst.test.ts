import { describe, expect, test } from "bun:test";
import { splitFrames } from "./analyst";

describe("splitFrames", () => {
  test("splits complete SSE frames and keeps the partial tail", () => {
    const [frames, rest] = splitFrames('event: text\ndata: {"delta":"a"}\n\nevent: done\r\ndata: {"rounds":0}\r\n\r\nevent: te');
    expect(frames).toEqual([
      { event: "text", data: '{"delta":"a"}' },
      { event: "done", data: '{"rounds":0}' },
    ]);
    expect(rest).toBe("event: te");
  });
  test("joins multi-line data and defaults the event name", () => {
    const [frames] = splitFrames("data: line1\ndata: line2\n\n");
    expect(frames).toEqual([{ event: "message", data: "line1\nline2" }]);
  });
});
