import { useState, type RefObject } from 'react'
import { Badge, Button, DialogShell, StatusDot, type DotStatus } from '../../components'
import { VenueBadge } from '../../components/intel/VenueBadge'
import { fmtAge } from '../../components/strategy/format'
import type { DeskStatus } from '../../lib/desk'
import type { PlatformHealth } from '../../../shared/platform'
import { healthItems, worstItem, type Level } from './logic'

// CockpitHeader, HealthStrip, KeysHelp — DESIGN-terminal C2/C6/C3.
// Presentational: data and callbacks come from Cockpit.tsx.

/** `APPROVE a`: the key hint shows on fine pointers only. */
export function KeyHint({ k }: { k: string }) {
  return <span className="hidden [@media(pointer:fine)]:inline text-text-secondary normal-case">{k}</span>
}

export function CockpitHeader({
  venue,
  liveCount,
  readyCount,
  desk,
  noDb,
  killRef,
  onKill,
  onHelp,
}: {
  venue: 'paper' | 'testnet' | null
  liveCount: number | null
  readyCount: number | null
  desk: { data: DeskStatus | null; offline: string | null; error: string | null }
  noDb: boolean
  /** KILL / RESUME: the kill dialog returns focus here. */
  killRef?: RefObject<HTMLButtonElement | null>
  onKill: () => void
  onHelp: () => void
}) {
  const kill = desk.data?.killSwitch
  const deskDown = !desk.data && (desk.offline ?? desk.error)
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base text-text-primary font-display tracking-wider">COCKPIT</h1>
        {deskDown ? (
          <span className="text-xs text-text-secondary" title={deskDown}>
            DESK —
          </span>
        ) : (
          <VenueBadge venue={venue} />
        )}
        {noDb && <Badge tone="gray">NO DATABASE — MEMORY STORE</Badge>}
        {liveCount != null && (
          <span className="text-sm tabular text-text-secondary">
            {liveCount} LIVE · {readyCount} READY
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button tier="ghost" onClick={onHelp} className="hidden [@media(pointer:fine)]:inline-flex" aria-label="keyboard shortcuts">
            ? KEYS
          </Button>
          {kill?.on ? (
            <>
              <Badge tone="red">KILLED</Badge>
              <span className="text-xs text-text-secondary" title={kill.reason}>
                {[kill.reason, kill.at ? fmtAge(kill.at) : null].filter(Boolean).join(' · ')}
              </span>
              <Button tier="ghost" ref={killRef} onClick={onKill} className="min-h-[var(--tap-min)]">
                RESUME <KeyHint k="x" />
              </Button>
            </>
          ) : (
            <Button tier="danger" ref={killRef} onClick={onKill} disabled={!desk.data} title={deskDown || undefined} className="min-h-[var(--tap-min)]">
              KILL <KeyHint k="x" />
            </Button>
          )}
        </div>
      </div>
      {desk.error && <p className="text-xs text-red-text">{desk.error}</p>}
    </div>
  )
}

const DOT: Record<Level, DotStatus> = { ok: 'ok', warn: 'degraded', critical: 'down', unknown: 'unknown' }
const TEXT: Record<Level, string> = { ok: 'text-text-secondary', warn: 'text-amber', critical: 'text-red-text', unknown: 'text-text-secondary' }

export function HealthStrip({ health, loading, offline, error, now }: { health: PlatformHealth | null; loading: boolean; offline: string | null; error: string | null; now: number }) {
  const [expanded, setExpanded] = useState(false)
  if (!health && loading) return <div className="h-3 my-2 w-1/2 bg-elevated pulse-label" />
  if (!health && (offline || error))
    return (
      <div className="flex items-center gap-2 py-1.5 text-xs text-red-text" role="status" title={offline ?? error ?? undefined}>
        <StatusDot status="down" /> HEALTH UNREACHABLE
      </div>
    )
  // Server up, platform runtime absent: every item gray (C6 "unknown").
  const items = health ? healthItems(health, now) : (['WS', 'SCAN', 'CRAWL', 'LOOPS', 'LLM'] as const).map((key) => ({ key, level: 'unknown' as const, value: '—', title: 'platform loops not running' }))
  const worst = worstItem(items)
  const strip = (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular" aria-label="system health">
      {items.map((i) => (
        <li key={i.key} className={`flex items-center gap-1.5 ${TEXT[i.level]}`} title={i.title}>
          <StatusDot status={DOT[i.level]} />
          <span className="label">{i.key}</span>
          <span>{i.value}</span>
          {i.level === 'critical' && <span className="sr-only">critical</span>}
          {i.level === 'warn' && <span className="sr-only">warning</span>}
        </li>
      ))}
    </ul>
  )
  return (
    <div className="py-1.5 border-y border-border-subtle">
      <div className="md:hidden">
        <button type="button" className="flex items-center gap-1.5 text-xs tabular min-h-[var(--tap-min)]" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {items.map((i) => (
            <StatusDot key={i.key} status={DOT[i.level]} />
          ))}
          <span className={TEXT[worst.level]}>
            {worst.key} {worst.value}
            {worst.level !== 'ok' && (worst.key === 'SCAN' || worst.key === 'WS') ? ' OLD' : ''}
          </span>
          <span className="text-text-secondary">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && <div className="pt-1">{strip}</div>}
      </div>
      <div className="hidden md:block">{strip}</div>
    </div>
  )
}

const KEYS: [string, string][] = [
  ['j / k', 'next / previous row'],
  ['Enter', 'open detail'],
  ['a', 'approve (READY only)'],
  ['r', 'reject'],
  ['s', 'snooze menu — 1 / 2 / 3 = 15M / 1H / 4H'],
  ['d', 'deeper research'],
  ['x', 'kill switch'],
  ['?', 'this list'],
  ['Esc', 'close the topmost dialog or menu'],
]

export function KeysHelp({ onClose }: { onClose: () => void }) {
  return (
    <DialogShell title="KEYS" onClose={onClose} className="md:max-w-[400px]">
      <table className="text-sm w-full">
        <tbody>
          {KEYS.map(([k, v]) => (
            <tr key={k} className="border-b border-border-subtle">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-text-primary tabular whitespace-nowrap">
                {k}
              </th>
              <td className="py-1 text-text-secondary">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end">
        <Button tier="ghost" onClick={onClose} data-autofocus>
          CLOSE
        </Button>
      </div>
    </DialogShell>
  )
}
