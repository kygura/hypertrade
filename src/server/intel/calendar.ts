import type { EventType, Magnitude } from "../../shared/intel.js";
import type { NewEvent } from "./store.js";

// Static US macro calendar (SPEC.md § Intel I0.10, I0.13): FOMC decisions,
// CPI and the Employment Situation (NFP) for 2026 and 2027, as scheduled
// catalysts. CHECK THESE DATES EVERY YEAR against the schedule pages below:
// agencies revise them (the 2025 shutdown moved several 2026 BLS releases),
// and the 2027 BLS dates here are estimates until BLS publishes its calendar.
// Estimated dates are tagged `hypothesis`; published ones `observed` with the
// schedule page as the source.

export const SCHEDULE_URL = {
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  cpi: "https://www.bls.gov/schedule/news_release/cpi.htm",
  nfp: "https://www.bls.gov/schedule/news_release/empsit.htm",
} as const;

export type MacroKind = keyof typeof SCHEDULE_URL;

interface KindSpec {
  title: string;
  label: string;
  /** Release time, US Eastern. */
  et: [number, number];
  magnitude: Magnitude;
}

const KIND: Record<MacroKind, KindSpec> = {
  fomc: { title: "FOMC rate decision", label: "Federal Reserve FOMC calendar", et: [14, 0], magnitude: "high" },
  cpi: { title: "US CPI release", label: "BLS CPI release schedule", et: [8, 30], magnitude: "high" },
  nfp: { title: "US jobs report (NFP)", label: "BLS Employment Situation schedule", et: [8, 30], magnitude: "med" },
};

/** Decision/release days (US Eastern dates). `estimated` = not yet published by the agency. */
export const MACRO_DATES: Record<MacroKind, Array<{ date: string; estimated?: boolean }>> = {
  // Second day of each two-day meeting, from the Fed's published schedule (2027 is tentative there too).
  fomc: [
    ...["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"].map((date) => ({ date })),
    ...["2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-22", "2027-10-27", "2027-12-08"].map((date) => ({ date, estimated: true })),
  ],
  cpi: [
    ...["2026-01-13", "2026-02-11", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10"].map((date) => ({ date })),
    ...["2027-01-13", "2027-02-10", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10", "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-13", "2027-11-10", "2027-12-10"].map((date) => ({ date, estimated: true })),
  ],
  nfp: [
    ...["2026-01-09", "2026-02-06", "2026-03-06", "2026-04-03", "2026-05-08", "2026-06-05", "2026-07-02", "2026-08-07", "2026-09-04", "2026-10-02", "2026-11-06", "2026-12-04"].map((date) => ({ date })),
    ...["2027-01-08", "2027-02-05", "2027-03-05", "2027-04-02", "2027-05-07", "2027-06-04", "2027-07-02", "2027-08-06", "2027-09-03", "2027-10-08", "2027-11-05", "2027-12-03"].map((date) => ({ date, estimated: true })),
  ],
};

/** US daylight time: second Sunday of March to the first Sunday of November. */
function usDst(y: number, m: number, d: number): boolean {
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (n - 1);
  };
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  return m === 3 ? d >= nthSunday(3, 2) : d < nthSunday(11, 1);
}

/** A US Eastern wall-clock time on `date` (YYYY-MM-DD) as a UTC ISO string. */
export function easternToUtc(date: string, hh: number, mm: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const offset = usDst(y, m, d) ? 4 : 5;
  return new Date(Date.UTC(y, m - 1, d, hh + offset, mm)).toISOString();
}

const ENTITIES = ["USD", "DXY", "NASDAQ"];
const TYPE: EventType = "macro";

/** Calendar catalysts scheduled at or after `from` (default: all). firstSeen is `now`; upserts keep the first one. */
export function calendarEvents(now: Date, from?: Date): NewEvent[] {
  const out: NewEvent[] = [];
  for (const kind of Object.keys(MACRO_DATES) as MacroKind[]) {
    const spec = KIND[kind];
    for (const { date, estimated } of MACRO_DATES[kind]) {
      const scheduledAt = easternToUtc(date, ...spec.et);
      if (from && Date.parse(scheduledAt) < from.getTime()) continue;
      out.push({
        key: `calendar:${kind}:${date}`,
        type: TYPE,
        title: estimated ? `${spec.title} (estimated date)` : spec.title,
        summary: null,
        entities: [kind.toUpperCase(), ...ENTITIES],
        assets: [],
        magnitude: spec.magnitude,
        sources: [{ label: spec.label, url: SCHEDULE_URL[kind] }],
        origin: "calendar",
        firstSeen: now.toISOString(),
        scheduledAt,
        catalyst: null,
        tag: estimated ? "hypothesis" : "observed",
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
}
