import { describe, expect, test } from "bun:test";
import { HOLDOUT_SHARE, MIN_WEEKS } from "../../server/lab/engine/eventStudy";
import { STUDY_HOLDOUT_SHARE, STUDY_MIN_WEEKS, studyLine, studyVerdict } from "./study";

const screen = (events: number, weeks: number, expectancy: number | null, upper95: number | null) => ({ events, weeks, expectancy, upper95 });

describe("studyLine", () => {
  test("the cut-offs mirror the engine's", () => {
    expect(STUDY_MIN_WEEKS).toBe(MIN_WEEKS);
    expect(STUDY_HOLDOUT_SHARE).toBe(HOLDOUT_SHARE);
    expect(studyVerdict("insufficient").text).toContain(`fewer than ${MIN_WEEKS} weeks`);
  });

  test("clear: trades, weeks, weekly average, why it is not rejected, then the two parts of the period", () => {
    expect(studyLine({ verdict: "clear", screen: screen(46, 42, 0.12, 0.31), train: screen(30, 28, 0.15, 0.4), holdout: screen(16, 14, 0.05, 0.5) })).toBe(
      "46 trades in 42 weeks; the average week returned +0.12R per trade after costs. The 95% upper bound +0.31R is not below 0, so the screen does not reject it. That is not proof of an edge. Earlier 70% of the period: +0.15R over 30 trades; most recent 30%: +0.05R over 16 trades.",
    );
  });

  test("rejected and insufficient say which cut-off decided; an empty part says so", () => {
    const rejected = studyLine({ verdict: "rejected", screen: screen(80, 40, -0.3, -0.05), train: screen(80, 40, -0.3, -0.05), holdout: screen(0, 0, null, null) });
    expect(rejected).toContain("(95% upper bound −0.05R) is below 0, so the screen rejects it.");
    expect(rejected).toContain("most recent 30%: no trades.");
    const thin = studyLine({ verdict: "insufficient", screen: screen(1, 1, 0.4, null), train: screen(1, 1, 0.4, null), holdout: screen(0, 0, null, null) });
    expect(thin).toContain("1 trade in 1 week;");
    expect(thin).toContain("Fewer than 30 weeks with trades, so the screen gives no verdict.");
  });

  test("no events: nothing to score", () => {
    const none = screen(0, 0, null, null);
    expect(studyLine({ verdict: "insufficient", screen: none, train: none, holdout: none })).toBe("The rule never fired on the studied coins, so there is nothing to score.");
  });
});
