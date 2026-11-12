import { ASSET_PATTERN, RuleSchema } from '../../server/lab/types'
import { STUDY_DEFAULTS, STUDY_EXIT_MAX, StudyRequestSchema, UNIVERSE_ASSET, type StudyRequest } from '../../shared/research'
import { fmtSigned, type Rule, type StudyArgs, type StudyResult } from './lab'

// /lab/study helpers (docs/RESEARCH.md "Study"): the `?rule=` link contract,
// the universe control → lab_event_study args, and the verdict words. Pure,
// so the board and the rule drill can link here without the page.

/** Stop and target of a study, in ATR. */
export type StudyExits = { stopAtr: number; targetAtr: number }

const tenth = (x: number) => Math.round(x * 10) / 10

/** One exit as typed or read from the URL → its value to 0.1 ATR (as the server keys it), or null unless in (0, max]. */
export function exitValue(raw: string | null | undefined, max: number): number | null {
  if (raw == null || raw.trim() === '') return null
  const n = tenth(Number(raw))
  return Number.isFinite(n) && n > 0 && n <= max ? n : null
}

/** `?stop=&target=` → the study's exits; a missing or bad value is that exit's default. */
export function parseExitParams(stop: string | null | undefined, target: string | null | undefined): StudyExits {
  return {
    stopAtr: exitValue(stop, STUDY_EXIT_MAX.stopAtr) ?? STUDY_DEFAULTS.stopAtr,
    targetAtr: exitValue(target, STUDY_EXIT_MAX.targetAtr) ?? STUDY_DEFAULTS.targetAtr,
  }
}

/** The `stop`/`target` query pairs of these exits: each omitted at its default. */
export function exitParams(e: StudyExits): [string, string][] {
  return [
    ...(e.stopAtr !== STUDY_DEFAULTS.stopAtr ? [['stop', String(e.stopAtr)] as [string, string]] : []),
    ...(e.targetAtr !== STUDY_DEFAULTS.targetAtr ? [['target', String(e.targetAtr)] as [string, string]] : []),
  ]
}

/**
 * The exits form: the typed draft against the exits the shown study ran with. Typing never runs a study (each run
 * is a trial): `canRun` once the draft is valid and differs, and only RUN (which puts it in the URL) runs it.
 */
export function exitsForm(draft: { stop: string; target: string }, applied: StudyExits): { exits: StudyExits | null; dirty: boolean; canRun: boolean; error: string | null } {
  const stopAtr = exitValue(draft.stop, STUDY_EXIT_MAX.stopAtr)
  const targetAtr = exitValue(draft.target, STUDY_EXIT_MAX.targetAtr)
  const exits = stopAtr != null && targetAtr != null ? { stopAtr, targetAtr } : null
  const dirty = !exits || exits.stopAtr !== applied.stopAtr || exits.targetAtr !== applied.targetAtr
  const error = stopAtr == null ? `STOP: 0.1–${STUDY_EXIT_MAX.stopAtr} ATR` : targetAtr == null ? `TARGET: 0.1–${STUDY_EXIT_MAX.targetAtr} ATR` : null
  return { exits, dirty, canRun: exits != null && dirty, error }
}

/**
 * Link to the event study of a rule: `/lab/study?rule=<encodeURIComponent(JSON)>`
 * plus `&coin=<encodeURIComponent(coin)>` when a coin is given, and `&stop=&target=`
 * for exits other than the defaults.
 */
export function studyHref(rule: Rule, coin?: string | null, exits: StudyExits = STUDY_DEFAULTS): string {
  const q = `rule=${encodeURIComponent(JSON.stringify(rule))}`
  const ex = exitParams(exits).map(([k, v]) => `&${k}=${v}`).join('')
  return `/lab/study?${q}${coin && coin !== UNIVERSE_ASSET ? `&coin=${encodeURIComponent(coin)}` : ''}${ex}`
}

/** A real coin: the `?coin=` or the rule's own asset, never the definitions' UNIVERSE_ASSET placeholder; '' when there is none. */
export const realCoin = (coin: string | null | undefined): string => (coin && coin !== UNIVERSE_ASSET ? coin : '')

/**
 * The rule with a real asset, for what needs one (OPEN RULE evaluates it, SAVE catalogues it): a definition's rule
 * carries the UNIVERSE_ASSET placeholder, so it takes `coin` when that is a ticker; null when there is none.
 */
export function concreteRule(rule: Rule, coin?: string | null): Rule | null {
  if (rule.asset !== UNIVERSE_ASSET) return rule
  const c = realCoin(coin)
  return ASSET_PATTERN.test(c) ? { ...rule, asset: c } : null
}

/** Path id of an ad-hoc (unsaved, run-less) rule in the drill: /lab/rules/study?rule=… resolves from `?rule=`. */
export const ADHOC_RULE_ID = 'study'

/** OPEN RULE from the study: the rule drill for an ad-hoc rule, with a back link to this study. */
export function ruleDrillHref(rule: Rule, coin?: string | null, exits?: StudyExits): string {
  return `/lab/rules/${ADHOC_RULE_ID}${studyHref(rule, coin, exits).slice('/lab/study'.length)}&from=study`
}

/**
 * An ad-hoc rule's catalogue id, if saved: the evaluation's `id` is the server's rule hash, which is the catalogue's
 * key (lab_catalogue_save), so a match in the catalogue list means it is already there.
 */
export const catalogueIdIn = (id: string | null | undefined, catalogue: readonly { id: string }[] | null | undefined): string | null =>
  id && catalogue?.some((e) => e.id === id) ? id : null

/** `?rule=` value (already URL-decoded) → a validated Rule; missing → neither; bad JSON or shape → the error to show. */
export function parseRuleParam(raw: string | null | undefined): { rule: Rule | null; error: string | null } {
  if (raw == null || raw.trim() === '') return { rule: null, error: null }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { rule: null, error: 'rule: not valid JSON' }
  }
  const r = RuleSchema.safeParse(json)
  if (r.success) return { rule: r.data, error: null }
  const issue = r.error.issues[0]
  const at = issue?.path.length ? `.${issue.path.join('.')}` : ''
  return { rule: null, error: `rule${at}: ${issue?.message ?? 'invalid'}` }
}

export type StudyUniverse = { kind: 'coin' } | { kind: 'top'; n: number } | { kind: 'mine' }

/** The tool's own default universe (top 20 by day volume; also its cap without a database). */
export const DEFAULT_TOP = 20
/** Universe control → lab_event_study args. `coin`: the study's coin (`?coin=`, else the rule's asset). */
export function studyArgs(rule: Rule, coin: string, u: StudyUniverse, exits: StudyExits = STUDY_DEFAULTS): StudyArgs {
  const base = { rule, stopAtr: exits.stopAtr, targetAtr: exits.targetAtr }
  if (u.kind === 'coin') return { ...base, coins: [coin] }
  if (u.kind === 'mine') return { ...base, mine: true }
  return { ...base, top: u.n }
}

/**
 * Which endpoint runs the study. The board's canonical universes (this coin, or the default top 20) go through
 * POST /api/research/study, with any exits (the route keys its cache by them): one cache with the board, one trial
 * per rule, scope, exits and UTC day, and a default-exit run here shows on the board. Any other universe (another
 * top N, my markets) calls the Lab tool.
 */
export function studyRoute(rule: Rule, coinIn: string, universe: StudyUniverse, exits: StudyExits = STUDY_DEFAULTS): { kind: 'board'; body: StudyRequest } | { kind: 'lab'; args: StudyArgs } {
  // "This coin" with no real coin (a definition's placeholder asset) is the default universe, never a coin called UNIVERSE.
  const coin = realCoin(coinIn)
  const u: StudyUniverse = universe.kind === 'coin' && !coin ? { kind: 'top', n: DEFAULT_TOP } : universe
  const ex = { stopAtr: exits.stopAtr, targetAtr: exits.targetAtr }
  const body = u.kind === 'coin' ? { rule, coin, ...ex } : u.kind === 'top' && u.n === DEFAULT_TOP ? { rule, ...ex } : null
  const ok = body ? StudyRequestSchema.safeParse(body) : null
  return ok?.success ? { kind: 'board', body: ok.data } : { kind: 'lab', args: studyArgs(rule, coin, u, exits) }
}

export type EventVerdict = StudyResult['verdict']

const VERDICT: Record<EventVerdict, { label: string; tone: 'green' | 'red' | 'gray'; text: string }> = {
  clear: { label: 'CLEAR', tone: 'green', text: 'not shown to lose: the 95% upper bound of the average result is not below 0. Never proof of an edge' },
  rejected: { label: 'REJECTED', tone: 'red', text: 'clearly lost: even the 95% upper bound of the average result is below 0' },
  insufficient: { label: 'INSUFFICIENT', tone: 'gray', text: 'fewer than 30 weeks with trades, so no verdict' },
}

export function studyVerdict(v: EventVerdict): { label: string; tone: 'green' | 'red' | 'gray'; text: string } {
  return VERDICT[v]
}

/** A signed R multiple: `+0.12R`, `—` for null. */
export const fmtR = (x: number | null) => (x == null ? '—' : `${fmtSigned(x)}R`)

/** The screen line of a study (the /lab/study VERDICT panel). */
export function screenLine(s: { events: number; weeks: number; expectancy: number | null; upper95: number | null }): string {
  return `${s.events} events · ${s.weeks} weeks · expectancy ${fmtR(s.expectancy)} · upper95 ${fmtR(s.upper95)}`
}

/**
 * The screen's cut-offs. Mirror MIN_WEEKS and HOLDOUT_SHARE in src/server/lab/engine/eventStudy.ts (a value import
 * would pull the engine into the bundle); study.test.ts asserts they are equal.
 */
export const STUDY_MIN_WEEKS = 30
export const STUDY_HOLDOUT_SHARE = 0.3

type ScreenFacts = { events: number; weeks: number; expectancy: number | null; upper95: number | null }

/**
 * An event study in one line: trades, weeks, the weekly-averaged result per trade, what the 95% upper bound says
 * about the server's verdict, then the same average on the earlier and the most recent part. Facts about a replay.
 */
export function studyLine(d: { verdict: EventVerdict; screen: ScreenFacts; train: ScreenFacts; holdout: ScreenFacts }): string {
  const s = d.screen
  if (s.events === 0) return 'The rule never fired on the studied coins, so there is nothing to score.'
  const trades = (n: number) => `${n} trade${n === 1 ? '' : 's'}`
  const head = `${trades(s.events)} in ${s.weeks} week${s.weeks === 1 ? '' : 's'}; the average week returned ${fmtR(s.expectancy)} per trade after costs.`
  const why =
    d.verdict === 'insufficient'
      ? `Fewer than ${STUDY_MIN_WEEKS} weeks with trades, so the screen gives no verdict.`
      : d.verdict === 'rejected'
        ? `Even the optimistic end of that estimate (95% upper bound ${fmtR(s.upper95)}) is below 0, so the screen rejects it.`
        : `The 95% upper bound ${fmtR(s.upper95)} is not below 0, so the screen does not reject it. That is not proof of an edge.`
  const part = (name: string, x: ScreenFacts) => `${name}: ${x.events === 0 ? 'no trades' : `${fmtR(x.expectancy)} over ${trades(x.events)}`}`
  const early = Math.round((1 - STUDY_HOLDOUT_SHARE) * 100)
  return `${head} ${why} ${part(`Earlier ${early}% of the period`, d.train)}; ${part(`most recent ${100 - early}%`, d.holdout)}.`
}
