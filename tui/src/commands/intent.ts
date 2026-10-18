// OrderCommand → OrderIntent. Pure; the ticket layer resolves/validates the result further.
import { OrderIntentSchema, type OrderIntent } from "../../../src/shared/intel.js";
import type { OrderCommand } from "./parse.js";

export interface IntentCtx {
  markPx: number;
  equityUsd: number;
  defaultLeverage: number;
  defaultRiskPct: number;
}
export type IntentResult = { ok: true; intent: OrderIntent; notes: string[] } | { ok: false; error: string };

const fail = (error: string): IntentResult => ({ ok: false, error });
const px6 = (x: number) => Number(x.toPrecision(6));

export function orderToIntent(cmd: OrderCommand, ctx: IntentCtx): IntentResult {
  if (!(ctx.markPx > 0)) return fail(`no mark price for ${cmd.coin}`);
  const long = cmd.side === "long";
  const entry = cmd.limitPx ?? ctx.markPx;
  const notes: string[] = [];
  const from = cmd.limitPx ? "limit" : "mark";

  // Stop distance in price units, when it is knowable from the entry alone.
  let dist: number | null = null;
  if (cmd.stop.type === "price") {
    if (long ? cmd.stop.px >= entry : cmd.stop.px <= entry) return fail(`stop ${cmd.stop.px} must be ${long ? "below" : "above"} entry ${entry} for a ${cmd.side}`);
    dist = Math.abs(entry - cmd.stop.px);
  } else if (cmd.stop.type === "pct") {
    dist = (entry * cmd.stop.pct) / 100;
  }

  let size: OrderIntent["size"];
  if (cmd.size && !("riskPct" in cmd.size)) {
    size = cmd.size;
  } else {
    const riskPct = cmd.size ? cmd.size.riskPct : ctx.defaultRiskPct;
    if (dist === null) return fail("risk sizing needs a price or % stop; use $ or % book with atr/pdl/pdh");
    if (!(ctx.equityUsd > 0)) return fail("risk sizing needs account equity, which is unknown; use $ or % book");
    const usd = Math.round(((ctx.equityUsd * riskPct) / 100 / (dist / entry)) * 100) / 100;
    size = { usd };
    notes.push(`${cmd.size ? "" : "size defaulted to "}risk ${riskPct}% of $${Math.round(ctx.equityUsd)} equity at ${((dist / entry) * 100).toFixed(2)}% stop = $${usd} notional`);
  }

  let target: number | undefined;
  if (cmd.tp) {
    if ("px" in cmd.tp) {
      if (long ? cmd.tp.px <= entry : cmd.tp.px >= entry) return fail(`tp ${cmd.tp.px} must be ${long ? "above" : "below"} entry ${entry} for a ${cmd.side}`);
      target = cmd.tp.px;
    } else {
      let move: number;
      if ("pct" in cmd.tp) move = (entry * cmd.tp.pct) / 100;
      else if (dist === null) return fail("tp in R needs a price or % stop");
      else move = dist * cmd.tp.r;
      target = px6(long ? entry + move : entry - move);
      notes.push(`tp ${"pct" in cmd.tp ? cmd.tp.pct + "%" : cmd.tp.r + "R"} from ${from} ${entry} = ${target}`);
    }
  }

  const parsed = OrderIntentSchema.safeParse({
    asset: cmd.coin,
    side: cmd.side,
    leverage: cmd.leverage ?? ctx.defaultLeverage,
    size,
    entry: cmd.limitPx ? { type: "limit", px: cmd.limitPx } : { type: "market" },
    stop: cmd.stop,
    ...(target !== undefined && { target }),
  });
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return fail(`${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`);
  }
  return { ok: true, intent: parsed.data, notes };
}
