// Static history index. Vercel's Node function bundler only includes files
// reachable via static imports (no directory scan), so this file is the
// mechanism for "list available history dates" — see ROUTINE.md "Repo
// workflow" for the exact append instructions the routine follows each run.
import d20260830 from "./2026-08-30.json" with { type: "json" };
import d20261008 from "./2026-10-08.json" with { type: "json" };
import d20261009 from "./2026-10-09.json" with { type: "json" };
import d20261010 from "./2026-10-10.json" with { type: "json" };

export const MARKETSTATE_HISTORY: Array<{ date: string; data: unknown }> = [
  { date: "2026-08-30", data: d20260830 },
  { date: "2026-10-08", data: d20261008 },
  { date: "2026-10-09", data: d20261009 },
  { date: "2026-10-10", data: d20261010 },
];
