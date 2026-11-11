import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AsyncBody, Panel, PanelHeader, Segmented } from '..'
import type { DefinitionsResponse, SetupReplayResponse } from '../../../shared/research'
import { signTone, useLab, type LabState } from '../../lib/lab'
import { defaultReplayHorizon, definitionForKind, kindLabel, replayFacts, replayRowsAt, REPLAY_POLL_MS, research } from '../../lib/research'
import { studyHref } from '../../lib/study'
import { DirectionWord } from './common'

// INTRADAY SETUPS · REPLAY — the platform's shipped intraday predicates replayed over HL candles
// (docs/RESEARCH.md S5). Facts only: entries, graded n, clusters, mean net with its interval, hit rate. A setup the
// stream cannot build is dimmed with its reason, never shown as 0. A replay of fixed predicates, not a Lab trial.
// Container (SetupReplay) owns the load and the poll while `pending`; SetupReplayView is presentational.

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
      <p className="px-3 py-2 text-xs text-text-secondary border-b border-border-subtle">
        replays the shipped fixed intraday predicates on 15-minute candles · not a trial: nothing is searched or tuned
      </p>
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
      <span className="uppercase tracking-wider">unavailable</span> · {d.reason ?? 'no reason given'}
    </p>
  )
}

const day = (iso: string) => iso.slice(0, 10)

function ReplayOk({ d, defs, horizon, onHorizon }: { d: SetupReplayResponse; defs: DefinitionsResponse | null; horizon: string | null; onHorizon: (h: string) => void }) {
  const h = horizon && d.horizons.includes(horizon) ? horizon : defaultReplayHorizon(d.horizons)
  const rows = replayRowsAt(d, h)
  const assumptionChars = d.assumptions.reduce((n, a) => n + a.length, 0)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <span className="label">HORIZON</span>
        <Segmented label="replay horizon" value={h} onChange={onHorizon} options={d.horizons.map((x) => ({ value: x, label: x.toUpperCase() }))} />
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-text-secondary">no setups at {h}</p>
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
                        <span className="text-xs text-text-secondary">ENTRIES </span>
                        {r.entries}
                      </span>
                      <span>
                        <span className="text-xs text-text-secondary">N </span>
                        {r.n}
                      </span>
                      <span>
                        <span className="text-xs text-text-secondary">CLUSTERS </span>
                        {r.clusters}
                      </span>
                      <span>
                        <span className="text-xs text-text-secondary">HIT </span>
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
