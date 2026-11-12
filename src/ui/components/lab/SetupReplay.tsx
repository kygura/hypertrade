import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AsyncBody, HowToRead, Panel, PanelHeader, Segmented, type Term } from '..'
import type { DefinitionsResponse, SetupReplayResponse } from '../../../shared/research'
import { signTone, useLab, type LabState } from '../../lib/lab'
import { defaultReplayHorizon, definitionForKind, kindLabel, REPLAY_MIN_CLUSTERS, replayFacts, replayLine, replayRowsAt, REPLAY_POLL_MS, research } from '../../lib/research'
import { studyHref } from '../../lib/study'
import { DirectionWord } from './common'

// INTRADAY SETUPS · REPLAY — the platform's shipped intraday predicates replayed over HL candles
// (docs/RESEARCH.md S5). Facts only: entries, graded n, clusters, mean net with its interval, hit rate. A setup the
// stream cannot build is dimmed with its reason, never shown as 0. A replay of fixed predicates, not a Lab trial.
// Container (SetupReplay) owns the load and the poll while `pending`; SetupReplayView is presentational.

/** What each replay number is (src/server/platform/replay.ts; the numbers go through the ledger's own groupStats). */
const REPLAY_TERMS: readonly Term[] = [
  ['HORIZON', 'how long after each entry the outcome is measured.'],
  ['ENTRIES', 'ideas the setup would have created in the window, after the scanner\'s own repeat rules: one live idea per coin and setup, then a cooldown before it can fire again.'],
  ['N', 'entries that could be graded at this horizon, that is, a price exists that long after the entry.'],
  ['CLUSTERS', 'graded entries grouped by signal time into buckets of one day or one horizon, whichever is longer. Entries in a bucket are not independent, so a bucket counts once.'],
  ['HIT', 'share of graded entries with a net return above 0.'],
  ['MEAN NET', 'average net return per entry at the horizon, taken over the cluster averages: the price move in the setup\'s direction minus fees each way and funding. Slippage is not charged, which flatters thin coins.'],
  ['95% [lo, hi]', `95% interval of that mean. Shown from ${REPLAY_MIN_CLUSTERS} clusters; a wide interval that spans 0 means the sign is not established.`],
  ['daily link', 'the daily-bar definition of the same idea on the same side. It opens that definition\'s event study, which is a separate test.'],
  ['not evaluable', 'the setup reads an input this data does not have (for example open interest), so it could not fire at all. That is not the same as firing 0 times.'],
]

type Poll<T> = Pick<LabState<T>, 'data' | 'loading' | 'error' | 'offline' | 'refetch'>

/** Loads the replay and, while the server says `pending`, asks again every REPLAY_POLL_MS; stops on any other state and on unmount. */
export function SetupReplay({ definitions }: { definitions: Poll<DefinitionsResponse> }) {
  const replay = useLab(() => research.replay(), [])
  const [horizon, setHorizon] = useState<string | null>(null)
  const pending = replay.data?.state === 'pending'
  const { refetch } = replay
  useEffect(() => {
    if (!pending) return
    const t = setInterval(refetch, REPLAY_POLL_MS)
    return () => clearInterval(t)
  }, [pending, refetch])
  return <SetupReplayView replay={replay} definitions={definitions.data} horizon={horizon} onHorizon={setHorizon} />
}

export interface SetupReplayViewProps {
  replay: Poll<SetupReplayResponse>
  definitions: DefinitionsResponse | null
  /** null = the default horizon (24h). */
  horizon: string | null
  onHorizon: (h: string) => void
}

export function SetupReplayView({ replay, definitions, horizon, onHorizon }: SetupReplayViewProps) {
  return (
    <Panel>
      <PanelHeader title="INTRADAY SETUPS · REPLAY" />
      <HowToRead className="px-3 py-2 border-b border-border-subtle">
        The scanner's intraday setups replayed over recent 15-minute candles: how often each would have fired and what the price did afterwards, per holding time. The rules are fixed, so
        this is not a trial: nothing is searched or tuned. It is history, not a forecast.
      </HowToRead>
      <AsyncBody {...replay} onRetry={replay.refetch} rows={3}>
        {(d) => (d.state === 'ok' ? <ReplayOk d={d} defs={definitions} horizon={horizon} onHorizon={onHorizon} /> : <ReplayNotOk d={d} />)}
      </AsyncBody>
    </Panel>
  )
}

function ReplayNotOk({ d }: { d: SetupReplayResponse }) {
  if (d.state === 'pending') {
    return (
      <p role="status" className="px-3 py-4 text-sm text-text-secondary">
        <span className="pulse-label">REPLAY RUNNING…</span> the first run takes about 4–5 minutes; this block checks again every {Math.round(REPLAY_POLL_MS / 1000)} s · the rest of the page is unaffected
      </p>
    )
  }
  return (
    <p className="px-3 py-4 text-sm text-text-secondary break-words">
      <span className="uppercase tracking-wider">unavailable</span> · {d.reason ?? 'no reason given'}. Each setup's entries, graded outcomes and mean net return would show here.
    </p>
  )
}

const day = (iso: string) => iso.slice(0, 10)

function ReplayOk({ d, defs, horizon, onHorizon }: { d: SetupReplayResponse; defs: DefinitionsResponse | null; horizon: string | null; onHorizon: (h: string) => void }) {
  const h = horizon && d.horizons.includes(horizon) ? horizon : defaultReplayHorizon(d.horizons)
  const rows = replayRowsAt(d, h)
  const assumptionChars = d.assumptions.reduce((n, a) => n + a.length, 0)
  const line = replayLine(rows, h)
  return (
    <>
      {line && <p className="px-3 pt-2 text-md text-text-primary">{line}</p>}
      <HowToRead terms={REPLAY_TERMS} className="px-3 py-2 border-b border-border-subtle">
        One block per setup and side. Read MEAN NET together with its 95% interval and the cluster count: a mean on a handful of clusters says little.
      </HowToRead>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <span className="label">HORIZON</span>
        <Segmented label="replay horizon" value={h} onChange={onHorizon} options={d.horizons.map((x) => ({ value: x, label: x.toUpperCase() }))} />
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-text-secondary">no setups at {h}: the replay returned no row for this holding time</p>
      ) : (
        <ul>
          {rows.map((r) => {
            const def = definitionForKind(defs, r.kind, r.side)
            const f = replayFacts(r)
            return (
              <li key={`${r.kind}|${r.side}|${r.horizon}`} data-evaluable={r.evaluable} className={`flex flex-col gap-1 px-3 py-2 border-b border-border-subtle last:border-b-0 min-w-0 ${r.evaluable ? '' : 'opacity-60'}`}>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                  <span className="text-sm font-semibold text-text-primary break-words">{kindLabel(r.kind)}</span>
                  <DirectionWord direction={r.side} className="text-xs" />
                  {def && (
                    <Link to={studyHref(def.rule)} className="text-xs text-text-secondary hover:text-text-primary underline-offset-2 hover:underline" title="the daily definition of this thesis: its event study over the top-20 universe (runs on load, a trial)">
                      daily: {def.name} →
                    </Link>
                  )}
                </div>
                {r.evaluable ? (
                  <>
                    <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm tabular text-text-primary">
                      <span>
                        <span className="text-xs text-text-secondary" title="ideas the setup would have created in the window">ENTRIES </span>
                        {r.entries}
                      </span>
                      <span>
                        <span className="text-xs text-text-secondary" title="entries graded at this horizon">N </span>
                        {r.n}
                      </span>
                      <span>
                        <span className="text-xs text-text-secondary" title="graded entries grouped by signal time; a group counts once">CLUSTERS </span>
                        {r.clusters}
                      </span>
                      <span>
                        <span className="text-xs text-text-secondary" title="share of graded entries with a net return above 0">HIT </span>
                        {f.hit}
                      </span>
                    </p>
                    <p className="flex flex-wrap gap-x-2 text-sm tabular">
                      <span className="text-xs text-text-secondary">MEAN NET </span>
                      <span className={r.meanNet == null ? 'text-text-primary' : signTone(r.meanNet)}>{f.mean}</span>
                      <span className="text-text-secondary">
                        <span className="text-xs">95% </span>
                        {f.interval}
                      </span>
                    </p>
                    {f.note && <p className="text-xs text-text-secondary">{f.note}</p>}
                  </>
                ) : (
                  <p className="text-xs text-text-secondary break-words">
                    <span className="uppercase tracking-wider">not evaluable</span> · {r.reason ?? 'the stream lacks an input this setup reads'}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-col gap-1 px-3 py-2 border-t border-border-subtle text-xs text-text-secondary">
        <p className="tabular break-words">
          {d.window ? `${day(d.window.from)} → ${day(d.window.to)}` : 'no window'} · {d.coins.length} coins · {d.grid} grid · mean net after fees and funding, over cluster means
        </p>
        {d.assumptions.length > 0 && (
          <details open={assumptionChars <= 160}>
            <summary className="cursor-pointer">ASSUMPTIONS · {d.assumptions.length}</summary>
            <ul className="mt-1 flex flex-col gap-0.5 list-disc pl-4">
              {d.assumptions.map((a, i) => (
                <li key={i} className="break-words">
                  {a}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </>
  )
}
