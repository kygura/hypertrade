import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RadarCallsFileSchema, RadarStateSchema } from "../../shared/radar.js";
import { RADAR_MAX_CALLS_SHOWN, RADAR_NOTE_MAX_CHARS, type RadarResponse, type UnavailableReason } from "../../shared/research.js";
import { gradeCalls, scorecardRows } from "../radar/calls.js";

// GET /api/radar (docs/RESEARCH.md B2): the routine's files in data/radar/ (ROUTINE.md), read with the radar's own
// schemas. Read-only: calls are graded in memory against state.json, never written back. Absent files (the Vercel
// bundle) are an `unavailable` answer with a fixed reason, not an error; the underlying error is only logged.
// Capped: the last RADAR_MAX_CALLS_SHOWN calls and RADAR_NOTE_MAX_CHARS of the latest note.

export interface RadarFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}
export const nodeRadarFs: RadarFs = { readFile: (p) => readFile(p, "utf8"), readdir: (p) => readdir(p) };

const NOTE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const unavailable = (reason: UnavailableReason): RadarResponse => ({ state: "unavailable", reason, latestNote: null, calls: [], scorecard: [] });

export async function readRadar(dir: string, fs: RadarFs = nodeRadarFs): Promise<RadarResponse> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (missing(e)) return unavailable("radar files not deployed");
    console.error("[radar] directory unreadable:", e);
    return unavailable("radar files unreadable");
  }
  const json = async (name: string): Promise<unknown | null> => (names.includes(name) ? JSON.parse(await fs.readFile(join(dir, name))) : null);
  try {
    const file = RadarCallsFileSchema.parse((await json("calls.json")) ?? {});
    const state = RadarStateSchema.parse((await json("state.json")) ?? {});
    const notes = names.includes("notes") ? (await fs.readdir(join(dir, "notes"))).filter((n) => NOTE.test(n)).sort() : [];
    const last = notes.at(-1);
    if (!last && !names.includes("calls.json") && !names.includes("state.json")) return unavailable("no radar data yet");
    const md = last ? await fs.readFile(join(dir, "notes", last)) : null;
    const latestNote = last && md != null ? { date: NOTE.exec(last)![1]!, markdown: md.slice(0, RADAR_NOTE_MAX_CHARS), truncated: md.length > RADAR_NOTE_MAX_CHARS } : null;
    const graded = gradeCalls(file, state);
    return { state: "ok", latestNote, calls: graded.calls.slice(-RADAR_MAX_CALLS_SHOWN), scorecard: scorecardRows(graded) };
  } catch (e) {
    console.error("[radar] files unreadable:", e);
    return unavailable("radar files unreadable");
  }
}
