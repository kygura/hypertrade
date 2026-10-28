import { useEffect, useState } from 'react'
import type { FlowQuadrant, NarrativeContrast, NarrativeHeadline, NarrativeLean, NarrativeRow, NarrativesResponse, NarrativeStage, NarrativeView } from '../../../shared/intel'
import { fmtPct, fmtUsd, classForPnl } from '../../../shared/format'
import { api } from '../../lib/api'
import { Badge, type Tone } from '../Badge'
import { Button } from '../Button'
import { DataTable, type Column } from '../DataTable'
import { Segmented } from '../Segmented'
import { EmptyBlock } from '../state'
import { ClaimAge } from '../intel/ClaimAge'
import { ClaimList } from '../intel/ClaimList'
import { fmtCost, toClaim } from '../intel/research'
import { sourceHref } from '../intel/SourceLink'

// NarrativesPanel — docs/SPEC.md § Narratives. One row per routine sector
// basket, strongest LTF flow first: HTF stage with the numbers it comes from,
// the 1h/6h/24h price × OI quadrants, the operator's lean and the latest
// contrast's read. Selecting a row opens the detail: the view editor (lean +
// note, saved server-side), the basket's recent headlines (one per news
// cluster) and the contrast research (continuation vs fade, vetted evidence,
// where it sits against the view).

const STAGE_TONE: Record<NarrativeStage, Tone> = { emerging: 'info', expanding: 'green', crowded: 'amber', fading: 'red', quiet: 'gray', unknown: 'gray' }
const QUAD: Record<FlowQuadrant, { short: string; title: string; cls: string }> = {
  long_build: { short: 'L+', title: 'long build: price up, OI up', cls: 'text-green' },
  short_cover: { short: 'S−', title: 'short cover: price up, OI down', cls: 'text-green' },
  short_build: { short: 'S+', title: 'short build: price down, OI up', cls: 'text-red-text' },
  long_unwind: { short: 'L−', title: 'long unwind: price down, OI down', cls: 'text-red-text' },
  quiet: { short: '·', title: 'quiet: no |z| ≥ 1 pair', cls: 'text-text-secondary' },
  unknown: { short: '–', title: 'not enough history for a z', cls: 'text-text-disabled' },
}
const LEANS: { value: NarrativeLean; label: string }[] = [
  { value: 'continuation', label: 'CONTINUATION' },
  { value: 'fade', label: 'FADE' },
  { value: 'unsure', label: 'UNSURE' },
]
const AGREEMENT_WORD: Record<NarrativeContrast['view']['agreement'], string> = {
  agrees: 'AGREES WITH YOUR VIEW',
  conflicts: 'CONFLICTS WITH YOUR VIEW',
  mixed: 'EVIDENCE UNCLEAR VS YOUR VIEW',
  no_view: 'NO VIEW GIVEN',
}

const pct = (x: number | null) => (x == null ? <span className="text-text-disabled">--</span> : <span className={classForPnl(x)}>{fmtPct(x / 100, { sign: true, decimals: 1 })}</span>)
const z = (x: number | null) => (x == null ? '--' : x.toFixed(1))

function Quads({ row }: { row: NarrativeRow }) {
  return (
    <span className="inline-flex gap-2 tabular-nums">
      {row.ltf.map((w) => {
        const q = QUAD[w.quadrant]
        return (
          <span key={w.window} title={`${w.window} ${q.title} · price z ${z(w.priceZ)}, OI z ${z(w.oiZ)}`} className={q.cls}>
            {q.short}
          </span>
        )
      })}
    </span>
  )
}

export function NarrativesPanel({ data, onChanged }: { data: NarrativesResponse; onChanged: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = data.narratives.find((n) => n.id === selectedId) ?? null

  const columns: Column<NarrativeRow>[] = [
    { key: 'label', label: 'NARRATIVE', priority: 1, sortValue: (r) => r.label, render: (r) => r.label.toUpperCase() },
    {
      key: 'stage',
      label: 'HTF',
      priority: 1,
      sortValue: (r) => r.stage,
      render: (r) => <Badge tone={STAGE_TONE[r.stage]}>{r.stage.toUpperCase()}</Badge>,
    },
    { key: 'ltf', label: <span title="1h · 6h · 24h price × OI">LTF</span>, priority: 1, render: (r) => <Quads row={r} /> },
    { key: 'rel7', label: '7D VS BTC', priority: 2, align: 'right', sortValue: (r) => r.htf.relBtc7d ?? -Infinity, render: (r) => pct(r.htf.relBtc7d) },
    { key: 'oi7', label: 'OI 7D', priority: 3, align: 'right', sortValue: (r) => r.htf.oiPct7d ?? -Infinity, render: (r) => pct(r.htf.oiPct7d) },
    { key: 'fz', label: 'FUND Z', priority: 3, align: 'right', sortValue: (r) => r.htf.fundingZ ?? -Infinity, render: (r) => z(r.htf.fundingZ) },
    { key: 'oi', label: 'OI', priority: 4, align: 'right', sortValue: (r) => r.oiUsd ?? -1, render: (r) => (r.oiUsd == null ? '--' : fmtUsd(r.oiUsd, { compact: true })) },
    { key: 'view', label: 'YOU', priority: 2, render: (r) => (r.view ? r.view.lean.toUpperCase() : <span className="text-text-disabled">--</span>) },
    {
      key: 'read',
      label: 'READ',
      priority: 2,
      render: (r) => (r.contrast ? <span title={AGREEMENT_WORD[r.contrast.view.agreement]}>{r.contrast.favours.toUpperCase()}</span> : <span className="text-text-disabled">--</span>),
    },
  ]

  return (
    <div className="flex flex-col">
      <DataTable
        columns={columns}
        rows={data.narratives}
        rowKey={(r) => r.id}
        onRowClick={(r) => setSelectedId((cur) => (cur === r.id ? null : r.id))}
        isSelected={(r) => r.id === selectedId}
        sortable
        emptyLabel={<EmptyBlock label="no narratives: the routine has not written sector baskets yet" />}
      />
      {selected && <NarrativeDetail key={selected.id} row={selected} onChanged={onChanged} />}
    </div>
  )
}

function NarrativeDetail({ row, onChanged }: { row: NarrativeRow; onChanged: () => void }) {
  return (
    <div className="flex flex-col gap-3 px-3 py-3 border-t border-border">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary">
        <span>
          {row.tokens.join(' · ')}
          {row.missing.length > 0 && <span className="text-text-disabled"> (no data: {row.missing.join(', ')})</span>}
        </span>
        <span>7D {pct(row.htf.pricePct7d)} · 30D {pct(row.htf.pricePct30d)} · 30D VS BTC {pct(row.htf.relBtc30d)} · OI 30D {pct(row.htf.oiPct30d)}</span>
        {row.firstSeen && <span>LISTED SINCE {row.firstSeen}</span>}
        <span>ALIGNMENT {row.alignment.toUpperCase()}</span>
      </div>
      <Headlines items={row.headlines} />
      <ViewEditor id={row.id} view={row.view} onSaved={onChanged} />
      <Contrast id={row.id} contrast={row.contrast} onDone={onChanged} />
    </div>
  )
}

function Headlines({ items }: { items: NarrativeHeadline[] }) {
  if (!items.length) return null
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label">HEADLINES</span>
      <ul className="flex flex-col gap-0.5">
        {items.map((h, i) => {
          const link = sourceHref(h.url ?? undefined)
          return (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
              {link?.kind === 'external' ? (
                <a href={link.href} target="_blank" rel="noreferrer" className="text-text-primary hover:underline break-words">
                  {h.title} ↗
                </a>
              ) : (
                <span className="text-text-primary break-words">{h.title}</span>
              )}
              <span className="text-text-muted">{h.assets.join(' · ')}</span>
              <ClaimAge ts={h.firstSeen} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ViewEditor({ id, view, onSaved }: { id: string; view: NarrativeView | null; onSaved: () => void }) {
  const [lean, setLean] = useState<NarrativeLean>(view?.lean ?? 'unsure')
  const [note, setNote] = useState(view?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = lean !== (view?.lean ?? 'unsure') || note.trim() !== (view?.note ?? '')

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.put<NarrativeView>(`/intel/narratives/${encodeURIComponent(id)}/view`, { lean, note })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">YOUR VIEW</span>
      <Segmented options={LEANS} value={lean} onChange={setLean} label="Your lean" disabled={busy} />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        rows={2}
        disabled={busy}
        placeholder="why: what you see that the numbers don't"
        className="w-full resize-y text-[12px]"
      />
      <div className="flex items-center gap-2">
        <Button tier="ghost" onClick={save} disabled={busy || !dirty}>
          {busy ? <span className="pulse-label">SAVING…</span> : 'SAVE VIEW'}
        </Button>
        {view && <span className="text-[10px] text-text-muted">saved <ClaimAge ts={view.updatedAt} /></span>}
        {error && <span className="text-[11px] text-red-text">{error}</span>}
      </div>
    </div>
  )
}

function Contrast({ id, contrast, onDone }: { id: string; contrast: NarrativeContrast | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<NarrativeContrast | null>(contrast)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setResult(contrast), [contrast])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<NarrativeContrast>(`/intel/narratives/${encodeURIComponent(id)}/contrast`)
      setResult(r)
      if (r.status === 'done') onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'contrast failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="label">CONTINUATION VS FADE</span>
        <Button tier="neutral" onClick={run} disabled={busy} className="ml-auto">
          {busy ? <span className="pulse-label">RESEARCHING…</span> : result ? 'RE-RUN' : 'RUN CONTRAST'}
        </Button>
      </div>
      {error && <p className="text-[11px] text-red-text">{error}</p>}
      {result && result.status !== 'done' && <p className="text-[11px] text-text-muted">{result.error ?? result.status}</p>}
      {result && result.status === 'done' && <ContrastBody c={result} />}
    </div>
  )
}

function Lines({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label">{title}</span>
      <ul className="flex flex-col gap-0.5">
        {lines.map((l, i) => (
          <li key={i} className="text-[11px] text-text-muted">
            {l}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ContrastBody({ c }: { c: NarrativeContrast }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={c.favours === 'continuation' ? 'green' : c.favours === 'fade' ? 'red' : 'gray'}>FAVOURS {c.favours.toUpperCase()}</Badge>
        <span title="the model's own confidence in this read — not a probability">
          <Badge tone="gray">{c.confidence.toUpperCase()}</Badge>
        </span>
        <Badge tone={c.view.agreement === 'conflicts' ? 'amber' : 'gray'}>{AGREEMENT_WORD[c.view.agreement]}</Badge>
        <span className="ml-auto text-[10px] text-text-muted">
          {c.searches} SEARCHES · {fmtCost(c.costUsd)} · <ClaimAge ts={c.createdAt} />
        </span>
      </div>
      {c.summary && <p className="text-[12px] text-text-primary break-words">{c.summary}</p>}
      {c.view.why && <p className="text-[11px] text-text-secondary break-words">{c.view.why}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {(['continuation', 'fade'] as const).map((side) => (
          <div key={side} className="flex flex-col gap-1">
            <span className="label">{side.toUpperCase()}</span>
            <p className="text-[12px] text-text-primary break-words">{c[side].case || <span className="text-text-disabled">no case survived validation</span>}</p>
            {c[side].evidence.length > 0 && <ClaimList claims={c[side].evidence.map(toClaim)} />}
          </div>
        ))}
      </div>
      <Lines title="CONFIRMS" lines={c.confirms} />
      <Lines title="INVALIDATES" lines={c.invalidates} />
      <Lines title="OPEN QUESTIONS" lines={c.openQuestions} />
    </div>
  )
}
