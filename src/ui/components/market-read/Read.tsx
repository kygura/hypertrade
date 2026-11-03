import { useMemo } from 'react'
import { marketBreadth } from '../../../shared/flow'
import { marketRead } from '../../../shared/marketRead'
import type { AssetCtx } from '../../../shared/types'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { Caption } from './Caption'

// READ — three plain sentences and three chips over the top 50 perps by OI (src/shared/marketRead.ts).

export function Read({ ctxs }: { ctxs: AssetCtx[] }) {
  const read = useMemo(() => marketRead(marketBreadth(ctxs, 50)), [ctxs])
  return (
    <Panel>
      <PanelHeader title="READ" />
      <Caption>Top 50 Hyperliquid perps by open interest, live.</Caption>
      <PanelBody className="p-3 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          {read.sentences.map((s) => (
            <p key={s} className="text-base text-text-primary">
              {s}
            </p>
          ))}
        </div>
        {read.chips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {read.chips.map((c) => (
              <span key={c.label} title={c.title} className="inline-flex items-baseline gap-2 px-2 py-1 bg-elevated cursor-help">
                <span className="label">{c.label}</span>
                <span className="text-md tabular text-text-primary">{c.value}</span>
              </span>
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
