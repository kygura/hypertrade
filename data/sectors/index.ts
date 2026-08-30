// Static history index. Vercel's Node function bundler only includes files
// reachable via static imports (no directory scan), so this file is the
// mechanism for "list available history dates" — see ROUTINE.md "Repo
// workflow" for the exact append instructions the routine follows each run.
import d20260830 from "./2026-08-30.json";

export const SECTORS_HISTORY: Array<{ date: string; data: unknown }> = [
  { date: "2026-08-30", data: d20260830 },
];
