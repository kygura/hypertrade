// First touch of a stop or a target inside one bar. Pure. The one resolver for every path grade: the Lab event
// study (daily bars), the scanner ledger's stop/target outcome (1-min candles) and the extremes grade (stored marks,
// a bar with o = h = l = the mark).

export type BarTouch = { exit: "stop" | "target"; px: number; ambiguous: boolean };

/**
 * `dir` 1 = long, -1 = short. Stop wins when both levels are inside the bar (`ambiguous`): the order within a bar is
 * unknown, so the worse one is assumed. A stop fills at the stop, or at the open when the bar gapped through it; a
 * target fills at the target. Null when neither is touched.
 */
export function barTouch(dir: 1 | -1, stop: number, target: number | null, bar: { o: number; h: number; l: number }): BarTouch | null {
  const stopHit = dir > 0 ? bar.l <= stop : bar.h >= stop;
  const tgtHit = target != null && (dir > 0 ? bar.h >= target : bar.l <= target);
  if (stopHit) return { exit: "stop", px: dir > 0 ? Math.min(stop, bar.o) : Math.max(stop, bar.o), ambiguous: tgtHit };
  return tgtHit ? { exit: "target", px: target!, ambiguous: false } : null;
}
