import { RuleSchema } from '../../server/lab/types'
import { fmtSigned, type Rule, type StudyArgs, type StudyResult } from './lab'

// /lab/study helpers (docs/RESEARCH.md "Study"): the `?rule=` link contract,
// the universe control → lab_event_study args, and the verdict words. Pure,
// so the board and the rule drill can link here without the page.

/**
 * Link to the event study of a rule: `/lab/study?rule=<encodeURIComponent(JSON)>`
 * plus `&coin=<encodeURIComponent(coin)>` when a coin is given.
 */
export function studyHref(rule: Rule, coin?: string | null): string {
  const q = `rule=${encodeURIComponent(JSON.stringify(rule))}`
  return `/lab/study?${q}${coin ? `&coin=${encodeURIComponent(coin)}` : ''}`
}

/** Path id of an ad-hoc (unsaved, run-less) rule in the drill: /lab/rules/study?rule=… resolves from `?rule=`. */
export const ADHOC_RULE_ID = 'study'

/** OPEN RULE from the study: the rule drill for an ad-hoc rule, with a back link to this study. */
export function ruleDrillHref(rule: Rule, coin?: string | null): string {
  return `/lab/rules/${ADHOC_RULE_ID}${studyHref(rule, coin).slice('/lab/study'.length)}&from=study`
}

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
/** Stop / target in ATR(14) when the rule has no levels of its own (the tool's documented example values). */
export const STUDY_STOP_ATR = 1.5
export const STUDY_TARGET_ATR = 3

/** Universe control → lab_event_study args. `coin`: the study's coin (`?coin=`, else the rule's asset). */
export function studyArgs(rule: Rule, coin: string, u: StudyUniverse): StudyArgs {
  const base = { rule, stopAtr: STUDY_STOP_ATR, targetAtr: STUDY_TARGET_ATR }
  if (u.kind === 'coin') return { ...base, coins: [coin] }
  if (u.kind === 'mine') return { ...base, mine: true }
  return { ...base, top: u.n }
}

export type EventVerdict = StudyResult['verdict']

const VERDICT: Record<EventVerdict, { label: string; tone: 'green' | 'red' | 'gray'; text: string }> = {
  clear: { label: 'CLEAR', tone: 'green', text: 'not shown to lose — never proof of an edge' },
  rejected: { label: 'REJECTED', tone: 'red', text: 'clearly lost: the 95% upper bound of expectancy is below 0' },
  insufficient: { label: 'INSUFFICIENT', tone: 'gray', text: 'fewer than 30 weeks with events — no verdict' },
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
