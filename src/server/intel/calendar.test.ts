import { describe, expect, test } from "bun:test";
import { IntelEventSchema } from "../../shared/intel.js";
import { calendarEvents, easternToUtc, MACRO_DATES, SCHEDULE_URL } from "./calendar.js";

const now = new Date("2026-10-13T12:00:00Z");

describe("macro calendar", () => {
  test("8 FOMC, 12 CPI and 12 NFP dates per year for 2026 and 2027, sorted and unique", () => {
    for (const [kind, n] of [["fomc", 8], ["cpi", 12], ["nfp", 12]] as const) {
      for (const year of ["2026", "2027"]) expect(MACRO_DATES[kind].filter((d) => d.date.startsWith(year))).toHaveLength(n);
      const dates = MACRO_DATES[kind].map((d) => d.date);
      expect([...dates].sort()).toEqual(dates);
      expect(new Set(dates).size).toBe(dates.length);
    }
    // Releases fall on weekdays.
    for (const d of Object.values(MACRO_DATES).flat()) expect([0, 6]).not.toContain(new Date(`${d.date}T12:00:00Z`).getUTCDay());
  });

  test("Eastern release times convert across daylight time", () => {
    expect(easternToUtc("2026-01-28", 14, 0)).toBe("2026-01-28T19:00:00.000Z");
    expect(easternToUtc("2026-10-28", 14, 0)).toBe("2026-10-28T18:00:00.000Z");
    expect(easternToUtc("2026-03-11", 8, 30)).toBe("2026-03-11T12:30:00.000Z"); // after the 2nd Sunday of March
    expect(easternToUtc("2026-11-06", 8, 30)).toBe("2026-11-06T13:30:00.000Z"); // after the 1st Sunday of November
  });

  test("events are valid catalysts: observed with the schedule URL, estimated dates are hypotheses", () => {
    const events = calendarEvents(now, now);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(IntelEventSchema.omit({ id: true, clusterId: true }).parse(e)).toBeTruthy();
      expect(Date.parse(e.scheduledAt!)).toBeGreaterThanOrEqual(now.getTime());
      expect(e).toMatchObject({ origin: "calendar", type: "macro" });
      expect(Object.values(SCHEDULE_URL)).toContain(e.sources[0]!.url as never);
    }
    const next = events[0]!;
    expect(next).toMatchObject({ key: "calendar:cpi:2026-10-14", title: "US CPI release", tag: "observed", scheduledAt: "2026-10-14T12:30:00.000Z", entities: ["CPI", "USD", "DXY", "NASDAQ"] });
    const est = events.find((e) => e.key === "calendar:nfp:2027-01-08")!;
    expect(est).toMatchObject({ tag: "hypothesis", title: "US jobs report (NFP) (estimated date)" });
    expect(calendarEvents(now)).toHaveLength(Object.values(MACRO_DATES).flat().length);
  });
});
