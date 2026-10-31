// Static history index. Vercel's Node function bundler only includes files
// reachable via static imports (no directory scan), so this file is the
// mechanism for "list available history dates" — see ROUTINE.md §2a
// for the exact append instructions the routine follows each run.
import d20260830 from "./2026-08-30.json" with { type: "json" };
import d20261008 from "./2026-10-08.json" with { type: "json" };
import d20261009 from "./2026-10-09.json" with { type: "json" };
import d20261010 from "./2026-10-10.json" with { type: "json" };
import d20261011 from "./2026-10-11.json" with { type: "json" };
import d20261012 from "./2026-10-12.json" with { type: "json" };
import d20261013 from "./2026-10-13.json" with { type: "json" };
import d20261014 from "./2026-10-14.json" with { type: "json" };
import d20261015 from "./2026-10-15.json" with { type: "json" };
import d20261019 from "./2026-10-19.json" with { type: "json" };
import d20261020 from "./2026-10-20.json" with { type: "json" };
import d20261021 from "./2026-10-21.json" with { type: "json" };
import d20261022 from "./2026-10-22.json" with { type: "json" };
import d20261023 from "./2026-10-23.json" with { type: "json" };
import d20261027 from "./2026-10-27.json" with { type: "json" };
import d20261028 from "./2026-10-28.json" with { type: "json" };
import d20261029 from "./2026-10-29.json" with { type: "json" };
import d20261030 from "./2026-10-30.json" with { type: "json" };
import d20261031 from "./2026-10-31.json" with { type: "json" };

export const MARKETSTATE_HISTORY: Array<{ date: string; data: unknown }> = [
  { date: "2026-08-30", data: d20260830 },
  { date: "2026-10-08", data: d20261008 },
  { date: "2026-10-09", data: d20261009 },
  { date: "2026-10-10", data: d20261010 },
  { date: "2026-10-11", data: d20261011 },
  { date: "2026-10-12", data: d20261012 },
  { date: "2026-10-13", data: d20261013 },
  { date: "2026-10-14", data: d20261014 },
  { date: "2026-10-15", data: d20261015 },
  { date: "2026-10-19", data: d20261019 },
  { date: "2026-10-20", data: d20261020 },
  { date: "2026-10-21", data: d20261021 },
  { date: "2026-10-22", data: d20261022 },
  { date: "2026-10-23", data: d20261023 },
  { date: "2026-10-27", data: d20261027 },
  { date: "2026-10-28", data: d20261028 },
  { date: "2026-10-29", data: d20261029 },
  { date: "2026-10-30", data: d20261030 },
  { date: "2026-10-31", data: d20261031 },
];
