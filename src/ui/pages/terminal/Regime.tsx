import { Badge, HowToRead, Panel, PanelBody, PanelHeader, type Term, type Tone } from '../../components'
import { AsyncBody, EmptyBlock } from '../../components/state'
import { LeanBar } from '../../components/LeanBar'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { agoWords } from '../../components/intel/format'
import { intel, useIntel } from '../../lib/intel'
import type { RegimeFeed } from '../../../shared/regime/schema'
import type { RegimeThesis, Stance } from '../../../shared/regime/types'

// `/regime` — the living regime thesis (docs/REGIME.md). One document about where the market sits, rewritten when
// new intelligence arrives (Glassnode's weekly report as the reference, every other open source weighed beside it),
// with how each source leans and a changelog of how the call moved. Read only: it informs a plan and never places one.

const STANCE: Record<Stance, { text: string; tone: Tone }> = {
  risk_off: { text: 'RISK-OFF', tone: 'red' },
  defensive: { text: 'DEFENSIVE', tone: 'amber' },
  neutral: { text: 'NEUTRAL', tone: 'gray' },
  constructive: { text: 'CONSTRUCTIVE', tone: 'info' },
  risk_on: { text: 'RISK-ON', tone: 'green' },
}

const LINE_TEXT = { bull_confirm: 'Confirms the bull case', bear_trigger: 'Triggers the bear case', invalidation: 'Invalidates the thesis' } as const

const TERMS: readonly Term[] = [
  ['Lean', 'how a source reads the market from here, from −2 (strongly bearish) to +2 (strongly bullish).'],
  ['Weight', 'how much a read counts: the source’s weight times how firmly it says it. Glassnode carries the most; own notes the least, since they repeat the others.'],
  ['Field', 'the weighted mean lean of every source, computed from the reads, never written by the model.'],
  ['Agreement', 'aligned (one side, little spread), split (spread out), contested (real weight on both sides) or thin (under three sources).'],
]

const signed = (x: number) => `${x > 0 ? '+' : ''}${x}`

export function Regime() {
  const feed = useIntel(() => intel.regime(), [], { cacheKey: 'intel.regime' })
  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col gap-3">
      <TerminalTabs />
      <AsyncBody {...feed} offline={!!feed.offline} rows={6} onRetry={feed.refetch}>
        {(d) => <RegimeBody feed={d} />}
      </AsyncBody>
      <HowToRead terms={TERMS}>
        One document about where the market sits, rewritten when new intelligence arrives. Glassnode is the reference; every other source counts beside it. It informs your plan and never places one.
      </HowToRead>
    </div>
  )
}

function RegimeBody({ feed }: { feed: RegimeFeed }) {
  const t = feed.thesis
  if (!t) {
    return (
      <Panel>
        <PanelHeader title="REGIME THESIS" />
        <EmptyBlock label={feed.persistent ? 'No thesis yet. The Regime workflow writes it (bun run regime seed <file>, then bun run regime update).' : 'This deployment keeps no regime thesis (no DATABASE_URL).'} />
      </Panel>
    )
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
      <div className="lg:col-span-7 min-w-0 flex flex-col gap-3">
        <Panel>
          <PanelHeader title="REGIME THESIS">
            <Badge tone={STANCE[t.stance].tone}>{STANCE[t.stance].text}</Badge>
            <Badge tone="gray">{t.conviction.toUpperCase()} CONVICTION</Badge>
          </PanelHeader>
          <PanelBody>
            <ThesisView t={t} />
          </PanelBody>
        </Panel>
      </div>
      <div className="lg:col-span-5 min-w-0 flex flex-col gap-3">
        <Sources t={t} />
        {feed.history.length > 0 && (
          <Panel>
            <PanelHeader title="CHANGELOG" />
            <PanelBody>
              <ol className="m-0 list-none px-3 py-2 flex flex-col gap-3">
                {feed.history.map((h) => (
                  <li key={h.id} className="text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium text-text-primary">{h.phase}</span>
                      <span className="text-text-secondary text-xs tabular-nums">
                        {h.version ? `v${h.version} · ` : 'notes · '}
                        {h.created.slice(0, 10)}
                      </span>
                    </div>
                    <p className="m-0 mt-1 text-text-secondary">{h.changelog}</p>
                  </li>
                ))}
              </ol>
            </PanelBody>
          </Panel>
        )}
      </div>
    </div>
  )
}

function ThesisView({ t }: { t: RegimeThesis }) {
  const c = t.consensus
  const upcoming = t.catalysts.filter((x) => x.status === 'upcoming')
  return (
    <div className="px-3 py-2 flex flex-col gap-4 text-sm">
      <div>
        <p className="m-0 text-base font-medium text-text-primary">{t.phase}</p>
        <p className="m-0 mt-1 text-xs text-text-secondary">
          v{t.version} · written {agoWords(t.created)} · {t.source_reads.length} sources · field {c.label} ({signed(c.score)}), {c.agreement}
        </p>
      </div>
      {t.tldr && <p className="m-0 text-text-primary">{t.tldr}</p>}
      {t.macro && (
        <p className="m-0 text-text-secondary">
          <span className="text-text-primary font-medium">Macro. </span>
          {t.macro}
        </p>
      )}
      {t.alts && (
        <p className="m-0 text-text-secondary">
          <span className="text-text-primary font-medium">Alts. </span>
          {t.alts}
        </p>
      )}
      {t.lines.length > 0 && (
        <ul className="m-0 pl-4 flex flex-col gap-1">
          {t.lines.map((l, i) => (
            <li key={i}>
              <span className="text-text-primary font-medium">{LINE_TEXT[l.kind]}: </span>
              <span className="text-text-secondary">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
      {t.key_levels.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-text-secondary">
              <tr>
                <th className="py-1 pr-3 font-normal">Metric</th>
                <th className="py-1 pr-3 font-normal">Level</th>
                <th className="py-1 pr-3 font-normal">Status</th>
                <th className="py-1 font-normal">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {t.key_levels.map((k, i) => (
                <tr key={i} className="border-t border-border-subtle align-top">
                  <td className="py-1.5 pr-3 text-text-primary">{k.metric}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{k.level}</td>
                  <td className="py-1.5 pr-3">{k.status}</td>
                  <td className="py-1.5 text-text-secondary">{k.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {t.scenarios.length > 0 && (
        <ul className="m-0 pl-0 list-none flex flex-col gap-1">
          {t.scenarios.map((x, i) => (
            <li key={i}>
              <span className="tabular-nums text-text-primary">{Math.round(x.probability * 100)}%</span> <span className="font-medium text-text-primary">{x.name}:</span>{' '}
              <span className="text-text-secondary">{x.path}</span>
            </li>
          ))}
        </ul>
      )}
      {upcoming.length > 0 && (
        <ul className="m-0 pl-0 list-none flex flex-col gap-1">
          {upcoming.map((x, i) => (
            <li key={i}>
              <span className="tabular-nums text-text-secondary">{x.date ?? 'TBD'}</span> <span className="text-text-primary">{x.event}</span> <span className="text-text-secondary">· {x.why}</span>
            </li>
          ))}
        </ul>
      )}
      {t.changes.length > 0 && (
        <div>
          <p className="m-0 text-xs text-text-secondary">What this version changed</p>
          <ul className="m-0 mt-1 pl-4 flex flex-col gap-1">
            {t.changes.map((x, i) => (
              <li key={i} className="text-text-secondary">
                <span className="text-text-primary">{x.what}:</span> {x.from ? `${x.from} → ` : ''}
                {x.to}. {x.because}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Sources({ t }: { t: RegimeThesis }) {
  const c = t.consensus
  const reads = [...t.source_reads].sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
  const ref = c.reference ? t.source_reads.find((r) => r.source === c.reference!.source) : null
  return (
    <Panel>
      <PanelHeader title="HOW THE SOURCES LEAN">
        <Badge tone={c.score <= -0.4 ? 'red' : c.score >= 0.4 ? 'green' : 'gray'}>
          FIELD {signed(c.score)} · {c.agreement.toUpperCase()}
        </Badge>
      </PanelHeader>
      <PanelBody>
        <div className="px-3 py-2 flex flex-col gap-3 text-sm">
          {ref ? (
            <p className="m-0 text-text-secondary">
              <span className="text-text-primary font-medium">Reference, {ref.name}: </span>
              {ref.claim} {c.reference_vs_field === 'agrees' ? 'The rest of the field agrees.' : c.reference_vs_field === 'differs' ? 'The rest of the field differs.' : ''}
            </p>
          ) : (
            <p className="m-0 text-text-secondary">Glassnode had nothing new in this version.</p>
          )}
          {t.agreement_notes && <p className="m-0 text-text-secondary">{t.agreement_notes}</p>}
          <ul className="m-0 p-0 list-none flex flex-col gap-2">
            {reads.map((r) => (
              <li key={r.source} className="flex flex-col gap-1 border-t border-border-subtle pt-2">
                <div className="flex items-center gap-2">
                  <LeanBar lean={r.lean / 2} width={64} />
                  <span className="tabular-nums w-6 text-right">{signed(r.lean)}</span>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer" className="text-text-primary underline decoration-border">
                      {r.name}
                    </a>
                  ) : (
                    <span className="text-text-primary">{r.name}</span>
                  )}
                  <span className="text-xs text-text-secondary">
                    {r.kind.replace('_', ' ')} · {(r.weight * r.confidence).toFixed(2)}
                  </span>
                </div>
                <p className="m-0 text-text-secondary">{r.claim}</p>
              </li>
            ))}
          </ul>
        </div>
      </PanelBody>
    </Panel>
  )
}
