import type { EventStudyOutput } from "./study.js";

// Test fixtures shared by the research tests.

/** A lab_event_study result with the fields the summary reads. */
export const fakeStudy = (over: Partial<EventStudyOutput> = {}): EventStudyOutput => ({
  text: "x", verdict: "clear",
  screen: { events: 120, weeks: 64, expectancy: 0.21, upper95: 0.38 },
  train: { events: 80, weeks: 44, expectancy: 0.25, upper95: 0.45 },
  holdout: { events: 40, weeks: 20, expectancy: 0.12, upper95: 0.4 },
  eventList: [], eventListTotal: 120, idea: { n: 7, of: 9 },
  ...over,
});
