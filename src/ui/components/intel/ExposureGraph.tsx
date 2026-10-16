import { useState, type KeyboardEvent } from 'react'
import { EDGE_TYPES, EDGE_TYPE_WEIGHT, type Edge, type EdgeType, type GraphPath } from '../../../shared/intel'
import { intel } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { ConfirmDialog } from '../ConfirmDialog'
import { EmptyBlock, ErrorBlock } from '../state'
import { ClaimAge } from './ClaimAge'
import { ExposurePathChips } from './ExposurePathChips'
import { hostLabel, useInlineForm } from './format'
import { SourceLink } from './SourceLink'

// ExposureGraph — DESIGN-terminal §15.6 (the §3.8 expanded row body as its own
// component). Edges grouped by type in weight order, origin badge (LLM =
// info: model-proposed), source, `verified` age (amber > 48 h); user edges
// delete behind a Level 2 confirm. Up to 8 two-hop paths; + ADD EDGE. `/`
// (ExposureAssetRow) and `/asset/:coin` render it from the same code; the
// caller owns the fetch and refetches on `onChanged`.

/** Edge types in weight order (DIRECT, COLLATERAL, SETTLES_ON, …). */
export const EDGE_ORDER: EdgeType[] = [...EDGE_TYPES].sort((a, b) => EDGE_TYPE_WEIGHT[b] - EDGE_TYPE_WEIGHT[a])

const ORIGIN_BADGE = {
  seed: <Badge tone="gray">SEED</Badge>,
  llm: <Badge tone="info">LLM</Badge>,
  user: <Badge tone="gray">USER</Badge>,
} as const

function edgeSource(source: string | null): { label: string; url?: string } | null {
  if (!source) return null
  if (/^https?:\/\//i.test(source)) {
    return { label: hostLabel(source), url: source }
  }
  return { label: source }
}

function EdgeForm({ asset, onAdded, onCancel, onKeyDown }: { asset: string; onAdded: () => void; onCancel: () => void; onKeyDown: (e: KeyboardEvent) => void }) {
  const [src, setSrc] = useState('')
  const [type, setType] = useState<EdgeType>('direct')
  const [dst, setDst] = useState(asset)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await intel.addEdge({ src: src.trim(), dst: dst.trim(), type, ...(url.trim() ? { source: url.trim() } : {}) })
      onAdded()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-2 pt-2"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="label">FROM</span>
          <input autoFocus value={src} onChange={(e) => setSrc(e.target.value)} maxLength={64} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="label">TYPE</span>
          <select value={type} onChange={(e) => setType(e.target.value as EdgeType)}>
            {EDGE_ORDER.map((t) => (
              <option key={t} value={t}>
                {t.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="label">TO</span>
          <input value={dst} onChange={(e) => setDst(e.target.value)} maxLength={64} />
        </label>
        <label className="flex flex-col gap-1 min-w-0">
          <span className="label">SOURCE URL</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="optional" />
        </label>
      </div>
      {error && <ErrorBlock message={error} />}
      <div className="flex gap-2">
        <Button tier="neutral" type="submit" disabled={busy || !src.trim() || !dst.trim()}>
          <span className={busy ? 'pulse-label' : undefined}>{busy ? 'ADDING…' : 'ADD EDGE'}</span>
        </Button>
        <Button tier="ghost" type="button" onClick={onCancel} disabled={busy}>
          CANCEL
        </Button>
      </div>
    </form>
  )
}

export function ExposureGraph({ asset, edges, paths, onChanged }: { asset: string; edges: Edge[]; paths: GraphPath[]; onChanged: () => void }) {
  const form = useInlineForm()
  const [del, setDel] = useState<Edge | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)

  const confirmDelete = async () => {
    if (!del) return
    setDelBusy(true)
    setDelErr(null)
    try {
      await intel.deleteEdge({ src: del.src, dst: del.dst, type: del.type })
      setDel(null)
      onChanged()
    } catch (err) {
      setDelErr(errorMessage(err))
    } finally {
      setDelBusy(false)
    }
  }

  return (
    <>
      {edges.length === 0 ? (
        <EmptyBlock label="no edges — the daily refresh adds them for held and watched assets" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-7 flex flex-col gap-2">
            {EDGE_ORDER.map((t) => {
              const group = edges.filter((e) => e.type === t).sort((a, b) => b.weight - a.weight)
              if (group.length === 0) return null
              return (
                <section key={t} className="flex flex-col gap-1">
                  <span className="label">
                    {t.toUpperCase()} · {group.length}
                  </span>
                  <ul className="flex flex-col gap-1">
                    {group.map((e) => {
                      const src = edgeSource(e.source)
                      return (
                        <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-[12px] text-text-primary">
                            {e.src} → {e.dst}
                          </span>
                          <span className="text-[11px] tabular text-text-muted">{e.weight.toFixed(2)}</span>
                          {ORIGIN_BADGE[e.origin]}
                          {src && <SourceLink source={src} />}
                          {e.lastVerified && <ClaimAge ts={e.lastVerified} thresholdHours={48} prefix="verified" />}
                          {e.origin === 'user' && (
                            <Button tier="danger" aria-label={`delete edge ${e.src} ${e.type} ${e.dst}`} onClick={() => setDel(e)}>
                              ✕
                            </Button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
          <div className="lg:col-span-5 flex flex-col gap-1">
            <span className="label">PATHS</span>
            {paths.length === 0 ? (
              <span className="text-[10px] text-text-secondary">no two-hop paths to held or watched assets</span>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {paths.slice(0, 8).map((p, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <ExposurePathChips path={p.edges} weight={p.weight} />
                    <span className="text-[11px] tabular text-text-muted">w {p.weight.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {form.open ? (
        <EdgeForm
          asset={asset}
          onAdded={() => {
            form.close()
            onChanged()
          }}
          onCancel={form.close}
          onKeyDown={form.onKeyDown}
        />
      ) : (
        <div className="pt-2">
          <Button tier="ghost" ref={form.openerRef} onClick={form.show}>
            + ADD EDGE
          </Button>
        </div>
      )}
      {del && (
        <ConfirmDialog
          title="DELETE EDGE"
          body={`Delete your edge ${del.src} →${del.type.toUpperCase()}→ ${del.dst}?`}
          confirmLabel="DELETE EDGE"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setDel(null)
            setDelErr(null)
          }}
        />
      )}
    </>
  )
}
