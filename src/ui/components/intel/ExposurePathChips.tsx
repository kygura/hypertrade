import { Fragment } from 'react'
import type { PathEdge } from '../../../shared/intel'

// ExposurePathChips — DESIGN-terminal §3.5 line 3 / §3.8 paths. Nodes as
// .src-tag-boxed names (11px, primary, normal case — entity names are not
// shouted), edges `→COLLATERAL→` 9px uppercase secondary; wraps between
// items. `title` = `2 hops · path weight 0.30`. Screen readers hear
// "Jito, via collateral to SOL".

export function pathTitle(path: PathEdge[], weight?: number): string {
  const hops = `${path.length} ${path.length === 1 ? 'hop' : 'hops'}`
  return weight != null ? `${hops} · path weight ${weight.toFixed(2)}` : hops
}

function Node({ name }: { name: string }) {
  return <span className="border border-border-subtle px-[5px] py-px text-sm text-text-primary whitespace-nowrap">{name}</span>
}

export function ExposurePathChips({ path, weight }: { path: PathEdge[]; weight?: number }) {
  if (path.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={pathTitle(path, weight)}>
      <Node name={path[0]!.from} />
      {path.map((e, i) => (
        <Fragment key={i}>
          <span className="text-2xs uppercase tracking-wider text-text-secondary whitespace-nowrap">
            <span aria-hidden="true">→{e.type.toUpperCase()}→</span>
            <span className="sr-only">, via {e.type.replace(/_/g, ' ')} to </span>
          </span>
          <Node name={e.to} />
        </Fragment>
      ))}
    </span>
  )
}
