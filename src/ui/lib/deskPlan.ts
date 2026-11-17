import {
  DeskPlanInputSchema,
  type CoinLock,
  type DeskCooldownResponse,
  type DeskPlanInput,
  type DeskPlanRecord,
  type DeskPlanSubmitResponse,
  type PlanCheck,
} from '../../shared/deskPlan'
import { fmtPx, fmtUsd } from './format'

// The Desk's written plan (docs/design/desk-calm.md §2, §3), pure: the form's
// draft → DeskPlanInput, when "Place plan" may be pressed, and the cooldown's
// wording. The server (src/server/desk/plan.ts checkPlan) owns the numbers and
// the blockers; this file only decides what the form sends and shows.

export type { DeskCooldownResponse, DeskPlanInput, DeskPlanRecord, DeskPlanSubmitResponse, PlanCheck }

export const MAX_RUNGS = 20
/** Wait this long after the last edit before asking the server to check the plan. */
export const CHECK_DEBOUNCE_MS = 450

export interface RungDraft {
  px: string
  size: string
}

/** What the form holds: every number is the text the operator typed. */
export interface PlanDraft {
  coin: string
  side: 'long' | 'short'
  rungs: RungDraft[]
  stop: string
  target: string
  note: string
}

export const emptyDraft = (coin = ''): PlanDraft => ({ coin, side: 'long', rungs: [{ px: '', size: '' }], stop: '', target: '', note: '' })

export const addRung = (d: PlanDraft): PlanDraft => (d.rungs.length >= MAX_RUNGS ? d : { ...d, rungs: [...d.rungs, { px: '', size: '' }] })

/** Removes a level; the last one stays (cleared instead). */
export const removeRung = (d: PlanDraft, i: number): PlanDraft =>
  d.rungs.length <= 1 ? { ...d, rungs: [{ px: '', size: '' }] } : { ...d, rungs: d.rungs.filter((_, j) => j !== i) }

/** A typed positive number ("61,250", " 0.5 "), else null. */
export function parsePositive(s: string): number | null {
  const t = s.trim().replace(/[,_\s]/g, '')
  if (!t || !/^\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

export interface DraftParse {
  /** The plan to check or submit; null while the form cannot make one. */
  input: DeskPlanInput | null
  /** Why not, in the form's words. */
  problems: string[]
}

/**
 * Form → DeskPlanInput. Fully blank levels are skipped. A blank stop or target is sent as null so the server's
 * check can say what is missing; a stop or target that is typed but not a number is a form problem.
 */
export function draftToInput(d: PlanDraft): DraftParse {
  const problems: string[] = []
  const coin = d.coin.trim().toUpperCase()
  if (!coin) problems.push('write a coin')
  const rungs: DeskPlanInput['rungs'] = []
  d.rungs.forEach((r, i) => {
    if (!r.px.trim() && !r.size.trim()) return
    const px = parsePositive(r.px)
    const size = parsePositive(r.size)
    if (px == null) problems.push(`level ${i + 1}: price is not a positive number`)
    if (size == null) problems.push(`level ${i + 1}: size is not a positive number`)
    if (px != null && size != null) rungs.push({ px, size })
  })
  if (rungs.length === 0 && !problems.some((p) => p.startsWith('level'))) problems.push('write at least one level: a price and a size')
  if (rungs.length > MAX_RUNGS) problems.push(`at most ${MAX_RUNGS} levels`)
  const level = (s: string, name: string): number | null => {
    if (!s.trim()) return null
    const n = parsePositive(s)
    if (n == null) problems.push(`${name} is not a positive number`)
    return n
  }
  const stopPx = level(d.stop, 'stop')
  const targetPx = level(d.target, 'target')
  if (problems.length) return { input: null, problems }
  const note = d.note.trim()
  const parsed = DeskPlanInputSchema.safeParse({ coin, side: d.side, rungs, stopPx, targetPx, ...(note ? { note } : {}) })
  if (!parsed.success) return { input: null, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`) }
  return { input: parsed.data, problems: [] }
}

/** Identity of a plan for the check: equal keys, same check. */
export const planKey = (input: DeskPlanInput): string => JSON.stringify(input)

/** The last check response and the request key it answers. */
export interface CheckResult {
  key: string
  check: PlanCheck | null
  error: string | null
}

export interface SubmitGate {
  canPlace: boolean
  canSave: boolean
  /** Why "Place plan" is disabled (null when it is enabled). */
  reason: string | null
}

/**
 * When the plan may be placed: a complete plan with a stop, checked by the server for exactly this input (no edit
 * since, no request outstanding), with no blockers, and no cooldown. Saving to the journal needs only a plan the
 * server can parse; the server checks and journals it either way.
 */
export function submitGate(a: { parse: DraftParse; key: string | null; result: CheckResult | null; locked: boolean; busy: boolean }): SubmitGate {
  const no = (reason: string, canSave = false): SubmitGate => ({ canPlace: false, canSave, reason })
  if (a.busy) return no('sending the plan')
  if (a.locked) return no('cooldown: new entries are locked')
  if (!a.parse.input || a.key == null) return no(a.parse.problems[0] ?? 'the plan is incomplete')
  if (a.parse.input.stopPx == null) return no('write a stop', true)
  if (!a.result || a.result.key !== a.key) return no('checking the plan', true)
  if (a.result.error != null || !a.result.check) return no(`the check failed: ${a.result.error ?? 'no answer'}`, true)
  const n = a.result.check.blockers.length
  if (n > 0) return no(`${n} ${n === 1 ? 'blocker' : 'blockers'} below`, true)
  return { canPlace: true, canSave: true, reason: null }
}

// ------------------------------------------------------------ wording

const pct = (x: number | null, dp = 1) => (x == null ? '—' : `${(Math.round(x * 10 ** dp) / 10 ** dp).toString()}%`)
const rr = (x: number | null) => (x == null ? '—' : x.toFixed(2))
const sizeText = (x: number) => (Math.round(x * 1e6) / 1e6).toString()

/** The numbers shown before submit, label → value. No fees. */
export function metricRows(c: PlanCheck): Array<[string, string]> {
  const m = c.metrics
  return [
    ['Total size', sizeText(m.totalSize)],
    ['Notional', fmtUsd(m.notionalUsd)],
    ['Avg entry, all filled', fmtPx(m.avgEntryPx)],
    ['Loss at stop', m.lossAtStopUsd == null ? '—' : `${fmtUsd(m.lossAtStopUsd)} (${pct(m.lossAtStopPct, 2)} of account)`],
    ['R:R all filled', rr(m.rrFull)],
    [`R:R top level only (${fmtPx(m.topRungPx)})`, rr(m.rrTopOnly)],
    ["Today's loss limit used", pct(m.dailyLimitUsedPct)],
    ['Max drawdown used', pct(m.drawdownUsedPct)],
    ['Mark', fmtPx(m.markPx)],
  ]
}

/** The Level 2 dialog body: restates the plan and names the venue (docs/design/README.md §7). */
export function placeSummary(input: DeskPlanInput, venue: string, check: PlanCheck | null): string {
  const n = input.rungs.length
  const total = input.rungs.reduce((a, r) => a + r.size, 0)
  const ladder = n === 1 ? `${sizeText(input.rungs[0]!.size)} ${input.coin} at ${fmtPx(input.rungs[0]!.px)}` : `${n} levels, ${sizeText(total)} ${input.coin} in total`
  const side = input.side === 'long' ? 'Long' : 'Short'
  const loss = check?.metrics.lossAtStopUsd
  const lossText = loss != null ? ` If the stop is hit the plan loses ${fmtUsd(loss)} (${pct(check!.metrics.lossAtStopPct, 2)} of the account), before fees.` : ''
  return `${side} ${input.coin} on ${venue.toUpperCase()}: ${ladder}, stop ${fmtPx(input.stopPx)}, target ${fmtPx(input.targetPx)}.${lossText} The plan is journaled either way.`
}

export type OutcomeTone = 'placed' | 'dry' | 'refused' | 'saved'

/** What became of a submit, in one calm line. */
export function submitOutcome(r: DeskPlanSubmitResponse, place: boolean): { tone: OutcomeTone; text: string } {
  const p = r.record.placement
  if (!place) return { tone: 'saved', text: 'Saved to the journal. Nothing was placed.' }
  if (p?.dryRun) return { tone: 'dry', text: `Dry run: the orders were built and recorded, nothing was sent.${p.note ? ` ${p.note}` : ''} Journaled.` }
  if (r.placed) return { tone: 'placed', text: `Placed.${p?.note ? ` ${p.note}` : ''} Journaled.` }
  if (p) return { tone: 'refused', text: `Not placed (${p.status})${p.error ? `: ${p.error}` : ''}. Journaled.` }
  const why = r.check.blockers.length ? `: ${r.check.blockers.join('; ')}` : ''
  return { tone: 'refused', text: `Not placed${why}. Journaled.` }
}

// ------------------------------------------------------------ cooldown

export type ActiveLock = { kind: 'all'; until: string; reason: string } | { kind: 'coin'; lock: DeskCooldownResponse['coins'][number] }

/** The lock that holds a new entry on `coin` at `now` (the global lock first), or null. */
export function lockFor(cd: DeskCooldownResponse | null, coin: string, now: number): ActiveLock | null {
  if (!cd) return null
  if (cd.all && Date.parse(cd.all.until) > now) return { kind: 'all', until: cd.all.until, reason: cd.all.reason }
  const c = coin.trim().toUpperCase()
  if (!c) return null
  const lock = cd.coins.find((l) => l.coin.toUpperCase() === c && Date.parse(l.until) > now)
  return lock ? { kind: 'coin', lock } : null
}

/** "about 3h left", "about 40 min left": coarse, never seconds. */
export function fmtTimeLeft(untilIso: string, now: number): string {
  const ms = Date.parse(untilIso) - now
  if (!(ms > 0)) return 'ending now'
  const min = Math.ceil(ms / 60_000)
  if (min <= 1) return 'less than a minute left'
  if (min < 60) return `about ${min} min left`
  return `about ${Math.round(min / 60)}h left`
}

/** "14:30 UTC"; with the date ("Nov 18 02:30 UTC") when it falls on another UTC day than `now`. */
export function fmtUntilUtc(iso: string, now: number): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  const hm = d.toISOString().slice(11, 16)
  if (d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return `${hm} UTC`
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${hm} UTC`
}

const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** "Two stop-outs today. New entries resume at 00:00 UTC." */
export function globalLockLine(until: string, stopOutsToday: number): string {
  const n = WORDS[stopOutsToday] ?? String(stopOutsToday)
  return `${n} stop-out${stopOutsToday === 1 ? '' : 's'} today. New entries resume at ${new Date(until).toISOString().slice(11, 16)} UTC.`
}

/** The journal entry behind a stop-out: the plan when the desk tied it to one, else the settled fill. */
export function stopOutEntry(lock: CoinLock & { plan: DeskPlanRecord | null }): string {
  const p = lock.plan?.input
  if (p) {
    const n = p.rungs.length
    return `Plan: ${p.side} ${p.coin}, ${n} ${n === 1 ? 'level' : 'levels'} from ${fmtPx(p.rungs[0]!.px)}, stop ${fmtPx(p.stopPx)}, target ${fmtPx(p.targetPx)}${p.note ? `. Note: ${p.note}` : ''}.`
  }
  const f = lock.ref.fill
  if (f) return `Settled fill: ${f.side} ${sizeText(f.size)} ${lock.coin} at ${fmtPx(f.px)}${f.pnl != null ? `, ${fmtUsd(f.pnl)}` : ''}.`
  return `No journal entry was tied to this stop-out (${lock.ref.source}).`
}
