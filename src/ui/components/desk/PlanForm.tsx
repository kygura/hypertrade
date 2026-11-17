import { useEffect, useRef, useState } from 'react'
import { Button } from '../Button'
import { ConfirmDialog } from '../ConfirmDialog'
import { HowToRead, type Term } from '../HowToRead'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { Segmented } from '../Segmented'
import { ErrorBlock } from '../state'
import { api, makeSequencer } from '../../lib/api'
import { errorMessage } from '../../lib/poll'
import {
  addRung,
  CHECK_DEBOUNCE_MS,
  draftToInput,
  emptyDraft,
  fmtUntilUtc,
  lockFor,
  MAX_RUNGS,
  metricRows,
  placeSummary,
  planKey,
  removeRung,
  submitGate,
  submitOutcome,
  type CheckResult,
  type DeskCooldownResponse,
  type DeskPlanInput,
  type DeskPlanSubmitResponse,
  type OutcomeTone,
  type PlanCheck,
  type PlanDraft,
} from '../../lib/deskPlan'
import { CooldownNotice, useMinuteClock } from './CooldownNotice'

// PlanForm — the only way to place an entry from the Desk (docs/design/desk-calm.md §2).
// The operator writes coin, side, a ladder of levels, a stop, a target and an
// optional note; the server checks the plan as it changes (debounced, stale
// answers dropped) and the form shows its numbers, blockers and warnings.
// "Place plan" opens the Level 2 dialog (docs/design/README.md §7) and is
// disabled while a blocker holds, the check is pending or stale, or there is
// no stop. Every submit is journaled, placed or not. A cooldown replaces the
// form with CooldownNotice; there is no override.

const PLAN_TERMS: Term[] = [
  ['Level', 'One price and size of the entry ladder. Propr rests every level as a limit order with its own stop and target. Paper and HL testnet fill one level at the mark, so they take a single level within 0.5% of it.'],
  ['Avg entry, all filled', 'Size-weighted average price of the levels, if every level fills.'],
  ['Loss at stop', 'What the plan loses if every level fills and the stop is hit, in USD and as a share of the account. Fees are not included.'],
  ['R:R', 'Distance to target over distance to stop. "All filled" uses the average entry; "top level only" uses the level that fills first (a long\'s highest, a short\'s lowest).'],
  ["Today's loss limit used", 'Loss already taken today plus this plan\'s loss at stop, as a share of the daily loss limit.'],
  ['Max drawdown used', 'This plan\'s loss at stop as a share of the account\'s maximum drawdown.'],
  ['✕ / ⚠', '✕ is a blocker: the plan cannot be placed until it is fixed. ⚠ is a warning: the plan can still be placed.'],
  ['SAVE TO JOURNAL', 'Records the plan and its check without placing anything.'],
]

/** Debounced POST /desk/plans/check for the current input; an answer for an older input is dropped. */
function usePlanCheck(input: DeskPlanInput | null) {
  const [nonce, setNonce] = useState(0)
  const key = input ? `${nonce}|${planKey(input)}` : null
  const [result, setResult] = useState<CheckResult | null>(null)
  const seq = useRef(makeSequencer())
  useEffect(() => {
    const ticket = seq.current.next()
    if (key == null) return
    const plan = JSON.parse(key.slice(key.indexOf('|') + 1)) as DeskPlanInput
    const t = setTimeout(() => {
      api.post<PlanCheck>('/desk/plans/check', { plan }).then(
        (check) => void (seq.current.isCurrent(ticket) && setResult({ key, check, error: null })),
        (err) => void (seq.current.isCurrent(ticket) && setResult({ key, check: null, error: errorMessage(err, 'check failed') })),
      )
    }, CHECK_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [key])
  return { key, result, recheck: () => setNonce((n) => n + 1) }
}

/** The check's numbers, blockers and warnings. `stale`: an edit since this answer; it is dimmed until the next one. */
export function PlanSummary({ check, stale }: { check: PlanCheck; stale: boolean }) {
  return (
    <div className={`flex flex-col gap-2 transition-opacity duration-300 ease-out ${stale ? 'opacity-60' : 'opacity-100'}`} data-testid="plan-summary">
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
        {metricRows(check).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-xs text-text-secondary">{k}</dt>
            <dd className="m-0 text-sm text-text-primary tabular text-right">{v}</dd>
          </div>
        ))}
      </dl>
      {check.blockers.length === 0 && check.warnings.length === 0 && <span className="text-xs text-text-secondary">No blockers.</span>}
      {check.blockers.map((b) => (
        <span key={b} className="text-xs text-red-text break-words">
          ✕ {b}
        </span>
      ))}
      {check.warnings.map((w) => (
        <span key={w} className="text-xs text-amber break-words">
          ⚠ {w}
        </span>
      ))}
    </div>
  )
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  placed: 'text-text-primary',
  dry: 'text-amber',
  refused: 'text-red-text',
  saved: 'text-text-secondary',
}

export function PlanForm({ venue, cooldown, onSubmitted, initialOpen = false }: { venue: string; cooldown: DeskCooldownResponse | null; onSubmitted: () => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const [draft, setDraft] = useState<PlanDraft>(() => emptyDraft())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [outcome, setOutcome] = useState<{ tone: OutcomeTone; text: string } | null>(null)
  const now = useMinuteClock()

  const lock = lockFor(cooldown, draft.coin, now)
  const parse = draftToInput(draft)
  const { key, result, recheck } = usePlanCheck(open && !lock ? parse.input : null)
  const gate = submitGate({ parse, key, result, locked: lock != null, busy })
  const pending = key != null && result?.key !== key
  const shown = result?.check ?? null

  const patch = (p: Partial<PlanDraft>) => {
    setDraft((d) => ({ ...d, ...p }))
    setOutcome(null)
  }
  const setRung = (i: number, p: Partial<PlanDraft['rungs'][number]>) => patch({ rungs: draft.rungs.map((r, j) => (j === i ? { ...r, ...p } : r)) })

  const submit = async (place: boolean) => {
    if (!parse.input) return false
    setBusy(true)
    setErr(null)
    try {
      const r = await api.post<DeskPlanSubmitResponse>('/desk/plans', { plan: parse.input, place })
      const o = submitOutcome(r, place)
      setOutcome(o)
      if (place && r.placed) {
        setDraft(emptyDraft())
        setOpen(false)
      }
      recheck()
      onSubmitted()
      return true
    } catch (e) {
      setErr(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const globalLock = lockFor(cooldown, '', now)
  const coinLocks = (cooldown?.coins ?? []).filter((l) => Date.parse(l.until) > now)

  return (
    <Panel>
      <PanelHeader title="PLAN">
        {open && !globalLock && (
          <Button tier="ghost" onClick={() => (setOpen(false), setDraft(emptyDraft()), setErr(null))} disabled={busy}>
            DISCARD
          </Button>
        )}
      </PanelHeader>
      <PanelBody className="flex flex-col gap-3 p-3">
        {globalLock ? (
          <CooldownNotice lock={globalLock} cooldown={cooldown} now={now} />
        ) : !open ? (
          <div className="flex flex-col gap-2" data-testid="plan-empty">
            <p className="m-0 text-md text-text-secondary">No plan open. Nothing to do.</p>
            {coinLocks.map((l) => (
              <span key={l.coin} className="text-xs text-text-secondary tabular">
                {l.coin}: new entries paused until {fmtUntilUtc(l.until, now)} after a stop-out.
              </span>
            ))}
            {outcome && <p className={`m-0 text-sm ${OUTCOME_CLASS[outcome.tone]}`}>{outcome.text}</p>}
            <div>
              <Button tier="ghost" onClick={() => (setOpen(true), setOutcome(null))}>
                WRITE A PLAN
              </Button>
            </div>
          </div>
        ) : (
          <>
            <HowToRead terms={PLAN_TERMS}>
              Write the whole trade before placing it: where you enter, how much at each level, where you are wrong (stop) and where you take profit (target). The
              desk checks the plan as you write and shows what it risks.
            </HowToRead>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="label text-2xs">COIN</span>
                <input
                  value={draft.coin}
                  onChange={(e) => patch({ coin: e.target.value.toUpperCase() })}
                  className="w-28 uppercase"
                  placeholder="BTC"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={20}
                  aria-label="coin"
                />
              </label>
              <div className="flex flex-col gap-1">
                <span className="label text-2xs">SIDE</span>
                <Segmented
                  label="side"
                  size="md"
                  value={draft.side}
                  onChange={(side) => patch({ side })}
                  options={[
                    { value: 'long', label: 'LONG', title: 'Buy: the plan profits if price rises to the target' },
                    { value: 'short', label: 'SHORT', title: 'Sell: the plan profits if price falls to the target' },
                  ]}
                />
              </div>
            </div>
            {lock ? (
              <CooldownNotice lock={lock} cooldown={cooldown} now={now} />
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <span className="label text-2xs">PRICE</span>
                    <span className="label text-2xs">SIZE ({draft.coin.trim() || 'coins'})</span>
                    <span className="w-[64px]" />
                  </div>
                  {draft.rungs.map((r, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                      <input value={r.px} onChange={(e) => setRung(i, { px: e.target.value })} inputMode="decimal" className="w-full min-w-0" aria-label={`level ${i + 1} price`} />
                      <input value={r.size} onChange={(e) => setRung(i, { size: e.target.value })} inputMode="decimal" className="w-full min-w-0" aria-label={`level ${i + 1} size`} />
                      <Button tier="ghost" className="w-[64px]" onClick={() => patch(removeRung(draft, i))} aria-label={`remove level ${i + 1}`}>
                        REMOVE
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button tier="ghost" onClick={() => patch(addRung(draft))} disabled={draft.rungs.length >= MAX_RUNGS}>
                      ADD LEVEL
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 min-w-0">
                    <span className="label text-2xs">STOP</span>
                    <input value={draft.stop} onChange={(e) => patch({ stop: e.target.value })} inputMode="decimal" className="w-full min-w-0" />
                  </label>
                  <label className="flex flex-col gap-1 min-w-0">
                    <span className="label text-2xs">TARGET</span>
                    <input value={draft.target} onChange={(e) => patch({ target: e.target.value })} inputMode="decimal" className="w-full min-w-0" />
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="label text-2xs">NOTE (OPTIONAL)</span>
                  <textarea
                    value={draft.note}
                    onChange={(e) => patch({ note: e.target.value })}
                    maxLength={1000}
                    className="w-full min-h-[48px] resize-y"
                    placeholder="Why this trade, and what would prove it wrong"
                  />
                </label>

                <div className="flex flex-col gap-2 border-t border-border-subtle pt-3" aria-live="polite">
                  {parse.problems.length > 0 && (
                    <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
                      {parse.problems.map((p) => (
                        <li key={p} className="text-xs text-text-secondary">
                          {p}
                        </li>
                      ))}
                    </ul>
                  )}
                  {parse.input && shown && <PlanSummary check={shown} stale={pending} />}
                  {parse.input && pending && <span className="text-xs text-text-secondary">checking the plan…</span>}
                  {parse.input && !pending && result?.error && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-text">the check failed: {result.error}</span>
                      <Button tier="ghost" onClick={recheck}>
                        RETRY
                      </Button>
                    </div>
                  )}
                </div>

                {err && !confirming && <ErrorBlock message={err} />}
                {outcome && <p className={`m-0 text-sm ${OUTCOME_CLASS[outcome.tone]}`}>{outcome.text}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  {gate.reason && <span className="text-xs text-text-secondary">{gate.reason}</span>}
                  <div className="ml-auto flex gap-2">
                    <Button tier="ghost" onClick={() => void submit(false)} disabled={!gate.canSave}>
                      SAVE TO JOURNAL
                    </Button>
                    <Button tier="neutral" onClick={() => (setErr(null), setConfirming(true))} disabled={!gate.canPlace}>
                      PLACE PLAN
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </PanelBody>
      {confirming && parse.input && (
        <ConfirmDialog
          title={`Place plan: ${parse.input.side} ${parse.input.coin}`}
          body={placeSummary(parse.input, venue, shown)}
          confirmLabel="PLACE PLAN"
          onConfirm={() => void submit(true).then((ok) => ok && setConfirming(false))}
          onCancel={() => setConfirming(false)}
          error={err}
          busy={busy}
        />
      )}
    </Panel>
  )
}
