import { entryMid, rMultiple } from "./ledger.js";
import type { HtfView, Setup, SetupProposal } from "./schema.js";

// Restraint is enforced here, not requested (docs/fallback-routine.md,
// pipeline step 6). Pure. A proposal that breaks a rule is dropped with the
// rule's name; nothing the model says about rr, status or ids is trusted.

export const GATE = {
  maxZoneWidthPct: 4,
  minInvalidationPct: 1,
  maxInvalidationPct: 25,
  minRr: 2,
  maxDays: { swing: 14, position: 45 },
  maxOpen: 5,
  maxNew: { pulse: 2, daily: 3 },
  maxCounterOpen: 1,
} as const;

export type GateMode = keyof typeof GATE.maxNew;

export interface GateContext {
  mode: GateMode;
  now: Date;
  /** Live HL universe: symbol → mark price. */
  marks: Map<string, number>;
  open: Setup[];
  /** Every id already used (open and closed), so new ids never collide. */
  usedIds: Set<string>;
  htf: HtfView | null;
}

export interface Rejection {
  asset: string;
  direction: string;
  rule: string;
  detail: string;
}

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The first rule a proposal breaks, or null. `accepted` counts toward the open-setup rules. */
export function checkProposal(p: SetupProposal, ctx: GateContext, accepted: Setup[]): { rule: string; detail: string } | null {
  const open = [...ctx.open, ...accepted];
  if (!ctx.htf) return { rule: "htf_missing", detail: "no HTF view: nothing is proposed before the view exists" };
  if (ctx.htf.stance === "stand_aside") return { rule: "htf_stand_aside", detail: "HTF stance is stand_aside" };
  if (accepted.length >= GATE.maxNew[ctx.mode]) return { rule: "cap_new", detail: `at most ${GATE.maxNew[ctx.mode]} new setups per ${ctx.mode} run` };
  if (open.length >= GATE.maxOpen) return { rule: "cap_open", detail: `at most ${GATE.maxOpen} open setups` };

  const mark = ctx.marks.get(p.asset);
  if (mark === undefined) return { rule: "unknown_asset", detail: `${p.asset} is not in the live Hyperliquid universe` };

  const long = p.direction === "long";
  const t = p.targets;
  const ordered = long
    ? p.invalidation < p.entry.low && p.entry.low <= p.entry.high && p.entry.high < t[0]! && t.every((x, i) => i === 0 || x > t[i - 1]!)
    : p.invalidation > p.entry.high && p.entry.high >= p.entry.low && p.entry.low > t[0]! && t.every((x, i) => i === 0 || x < t[i - 1]!);
  if (!ordered) return { rule: "levels_order", detail: long ? "long needs invalidation < entry.low ≤ entry.high < targets ascending" : "short needs invalidation > entry.high ≥ entry.low > targets descending" };
  if (long ? mark <= p.invalidation : mark >= p.invalidation) return { rule: "already_invalid", detail: `mark ${mark} is already beyond invalidation ${p.invalidation}` };

  const mid = entryMid(p);
  const widthPct = ((p.entry.high - p.entry.low) / mid) * 100;
  if (widthPct > GATE.maxZoneWidthPct) return { rule: "zone_width", detail: `entry zone ${r2(widthPct)}% wide (max ${GATE.maxZoneWidthPct}%)` };
  const invPct = (Math.abs(mid - p.invalidation) / mid) * 100;
  if (invPct < GATE.minInvalidationPct || invPct > GATE.maxInvalidationPct)
    return { rule: "invalidation_distance", detail: `invalidation ${r2(invPct)}% from entry mid (allowed ${GATE.minInvalidationPct}–${GATE.maxInvalidationPct}%)` };
  const rr = rMultiple(p, t[0]!);
  if (rr < GATE.minRr) return { rule: "rr", detail: `R:R to first target ${rr} (min ${GATE.minRr})` };

  const expires = Date.parse(p.expires_at);
  const maxDays = GATE.maxDays[p.horizon];
  if (!Number.isFinite(expires) || expires <= ctx.now.getTime()) return { rule: "expiry", detail: `expires_at ${p.expires_at} is not a future time` };
  if (expires - ctx.now.getTime() > maxDays * DAY) return { rule: "expiry", detail: `expires more than ${maxDays} days out (${p.horizon})` };

  if (open.some((s) => s.asset === p.asset && s.direction === p.direction)) return { rule: "duplicate", detail: `an open ${p.asset} ${p.direction} setup already exists` };
  if (p.regime_alignment === "counter") {
    if (p.conviction !== "low") return { rule: "counter_conviction", detail: "a counter-regime setup must be conviction low" };
    if (open.filter((s) => s.regime_alignment === "counter").length >= GATE.maxCounterOpen) return { rule: "counter_cap", detail: `at most ${GATE.maxCounterOpen} counter-regime setup open` };
  }
  return null;
}

export function makeSetupId(asset: string, direction: string, now: Date, used: Set<string>): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  for (let n = 1; ; n++) {
    const id = `${asset}-${direction}-${day}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** Gates proposals in the model's order; accepted ones become `watching` setups with code-computed rr and id. */
export function gateProposals(proposals: SetupProposal[], ctx: GateContext): { accepted: Setup[]; rejected: Rejection[] } {
  const accepted: Setup[] = [];
  const rejected: Rejection[] = [];
  const used = new Set(ctx.usedIds);
  const nowIso = ctx.now.toISOString();
  for (const p of proposals) {
    const fail = checkProposal(p, ctx, accepted);
    if (fail) {
      rejected.push({ asset: p.asset, direction: p.direction, ...fail });
      continue;
    }
    const id = makeSetupId(p.asset, p.direction, ctx.now, used);
    used.add(id);
    accepted.push({
      id,
      asset: p.asset,
      direction: p.direction,
      horizon: p.horizon,
      thesis: p.thesis,
      regime_alignment: p.regime_alignment,
      trigger: p.trigger,
      entry: p.entry,
      invalidation: p.invalidation,
      invalidation_reason: p.invalidation_reason,
      targets: p.targets,
      rr: rMultiple(p, p.targets[0]!),
      conviction: p.conviction,
      evidence: p.evidence,
      status: "watching",
      status_note: null,
      r_result: null,
      triggered_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      expires_at: new Date(Date.parse(p.expires_at)).toISOString(),
    });
  }
  return { accepted, rejected };
}
