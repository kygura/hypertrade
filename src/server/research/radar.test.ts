import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RadarResponseSchema } from "../../shared/research.js";
import { readRadar, type RadarFs } from "./radar.js";

const RADAR_FIXTURE = join(import.meta.dir, "fixtures/radar");

const memFs = (files: Record<string, string>): RadarFs => ({
  readFile: async (p) => {
    if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return files[p]!;
  },
  readdir: async (p) => {
    const names = new Set(Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!));
    if (!names.size) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    return [...names];
  },
});

describe("readRadar", () => {
  test("fixture dir: latest dated note, calls graded in memory against state.json, scorecard rows", async () => {
    const r = RadarResponseSchema.parse(await readRadar(RADAR_FIXTURE));
    expect(r.state).toBe("ok");
    expect(r.latestNote).toEqual({ date: "2026-11-01", markdown: "# Radar 2026-11-01\nlatest note\n", truncated: false });
    expect(r.calls.map((c) => [c.id, c.rel])).toEqual([
      ["2026-11-01-1-HYPE", { "3": 8.91 }], // (35.2/32) / (101000/100000) − 1
      ["2026-11-01-2-SOL", { "3": -1.5 }], // already graded: kept
    ]);
    expect(r.scorecard).toEqual([
      { stance: "ride", horizonDays: 3, n: 1, meanPct: 8.91, hits: 1 },
      { stance: "fade", horizonDays: 3, n: 1, meanPct: -1.5, hits: 0 },
    ]);
  });

  test("missing dir, empty dir and malformed files are unavailable with a fixed reason (no paths, no error text)", async () => {
    const gone = await readRadar(join(RADAR_FIXTURE, "nope"));
    expect(gone).toEqual({ state: "unavailable", reason: "radar files not deployed", latestNote: null, calls: [], scorecard: [] });
    expect((await readRadar("/d", memFs({ "/d/other.txt": "" }))).reason).toBe("no radar data yet");
    const bad = await readRadar("/d", memFs({ "/d/calls.json": '{"calls":[{"id":1}]}' }));
    expect(bad).toMatchObject({ state: "unavailable", reason: "radar files unreadable" });
  });

  test("notes only: ok with no calls", async () => {
    const r = await readRadar("/d", memFs({ "/d/notes/2026-11-02.md": "n", "/d/notes/draft.md": "x" }));
    expect(r).toEqual({ state: "ok", latestNote: { date: "2026-11-02", markdown: "n", truncated: false }, calls: [], scorecard: [] });
  });

  test("capped: the last 50 calls (scorecard over all), the note cut at 20k chars with truncated", async () => {
    const call = (i: number) => ({ id: `c${i}`, date: "2026-11-01", at: "2026-11-01T13:00:00.000Z", market: "HYPE", stance: "ride", direction: "long", kind: "catalyst", thesis: "t",
      cause_url: "https://example.com", cause_date: "2026-11-01", kill_price: 30, kill_if: "below 30", mark: 32, btc: 1, rel: { "3": 1 }, killed_at: null });
    const r = RadarResponseSchema.parse(await readRadar("/d", memFs({
      "/d/calls.json": JSON.stringify({ calls: Array.from({ length: 60 }, (_, i) => call(i)) }),
      "/d/notes/2026-11-02.md": "x".repeat(25_000),
    })));
    expect(r.calls.map((c) => c.id)).toEqual(Array.from({ length: 50 }, (_, i) => `c${i + 10}`));
    expect(r.scorecard).toEqual([{ stance: "ride", horizonDays: 3, n: 60, meanPct: 1, hits: 60 }]);
    expect(r.latestNote).toMatchObject({ date: "2026-11-02", truncated: true });
    expect(r.latestNote!.markdown).toHaveLength(20_000);
  });
});
