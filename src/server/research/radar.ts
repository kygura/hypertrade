import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RadarCallsFileSchema, RadarStateSchema } from "../../shared/radar.js";
import type { RadarResponse } from "../../shared/research.js";
import { gradeCalls, scorecardRows } from "../radar/calls.js";

// GET /api/radar (docs/RESEARCH.md B2): the routine's files in data/radar/ (ROUTINE.md), read with the radar's own
// schemas. Read-only: calls are graded in memory against state.json, never written back. Absent files (the Vercel
// bundle) are an `unavailable` answer with the reason, not an error.

export interface RadarFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}
export const nodeRadarFs: RadarFs = { readFile: (p) => readFile(p, "utf8"), readdir: (p) => readdir(p) };

const NOTE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const unavailable = (reason: string): RadarResponse => ({ state: "unavailable", reason, latestNote: null, calls: [], scorecard: [] });

export async function readRadar(dir: string, fs: RadarFs = nodeRadarFs): Promise<RadarResponse> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    return unavailable(missing(e) ? `no radar directory on this deployment (${dir})` : `radar directory unreadable: ${msg(e)}`);
  }
  const json = async (name: string): Promise<unknown | null> => (names.includes(name) ? JSON.parse(await fs.readFile(join(dir, name))) : null);
  try {
    const file = RadarCallsFileSchema.parse((await json("calls.json")) ?? {});
    const state = RadarStateSchema.parse((await json("state.json")) ?? {});
    const notes = names.includes("notes") ? (await fs.readdir(join(dir, "notes"))).filter((n) => NOTE.test(n)).sort() : [];
    const last = notes.at(-1);
    if (!last && !names.includes("calls.json") && !names.includes("state.json")) return unavailable("the radar directory holds no calls, state or notes yet");
    const latestNote = last ? { date: NOTE.exec(last)![1]!, markdown: await fs.readFile(join(dir, "notes", last)) } : null;
    const graded = gradeCalls(file, state);
    return { state: "ok", latestNote, calls: graded.calls, scorecard: scorecardRows(graded) };
  } catch (e) {
    return unavailable(`radar files unreadable: ${msg(e)}`);
  }
}
