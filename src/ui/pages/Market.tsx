import { useMemo, type ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { deriveSignals } from '../../shared/signals'
import { Panel, PanelBody, PanelHeader, PageContainer, StatusDot } from '../components'
import { ErrorBlock, SkeletonRows } from '../components/state'
import { Caption, FundingBoard, FundingHeatmap, Movers, OiMap, PremiumBoard, Read, SignalList } from '../components/market-read'
import { ageText, floorUniverse } from '../components/market-read/logic'
import { useNow } from '../lib/hooks'
import { useLiveUniverse } from '../lib/hlLive'
import { MarketsTable } from './Markets'

// MARKET — the landing page (`/`): what Hyperliquid is doing, where leverage is crowded and
// what is unusual right now, read straight from HL's public API in the browser
// (src/ui/lib/hlLive.ts). No panel needs the backend except ALL PERPS' builder dexes.

/** A panel shell for first load or a failed first load: skeleton, else the error. Never an empty panel. */
function Pending({ title, caption, error, rows = 3 }: { title: string; caption: string; error: string | null; rows?: number }) {
  return (
    <Panel>
      <PanelHeader title={title} />
      <Caption>{caption}</Caption>
      <PanelBody className="p-3">{error ? <ErrorBlock message={error} /> : <SkeletonRows rows={rows} />}</PanelBody>
    </Panel>
  )
}

export function Market() {
  const [params] = useSearchParams()
  // Old Telegram links pointed at `/?review=1` while `/` was the Cockpit.
  if (params.get('review') === '1') return <Navigate to="/terminal?review=1" replace />
  return <MarketPage />
}

function MarketPage() {
  const live = useLiveUniverse()
  const now = useNow(1000)
  const universe = useMemo(() => floorUniverse(live.ctxs), [live.ctxs])
  const signals = useMemo(() => deriveSignals({ ctxs: live.ctxs, predicted: live.predicted, atCap: live.atCap }), [live.ctxs, live.predicted, live.atCap])
  const ready = live.ctxs.length > 0
  const err = ready ? null : live.error

  const panel = (title: string, caption: string, body: () => ReactNode, rows?: number) =>
    ready ? body() : <Pending title={title} caption={caption} error={err} rows={rows} />

  return (
    <PageContainer className="py-3 md:py-[var(--gutter)] flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-text-secondary tabular" aria-live="polite">
        <StatusDot status={ready ? (live.error ? 'degraded' : 'ok') : live.error ? 'down' : 'unknown'} />
        <span>
          LIVE · Hyperliquid · {ageText(live.updatedAt, now)}
          {ready && live.error ? ' · last poll failed, showing the last good snapshot' : ''}
        </span>
      </div>

      {panel('READ', 'Top 50 Hyperliquid perps by open interest, live.', () => <Read ctxs={live.ctxs} />, 3)}

      {panel(
        'SIGNALS',
        'What is unusual right now, one card per coin, strongest first. Each card shows the rule that fired.',
        () => (
          <Panel>
            <PanelHeader title="SIGNALS">
              <span className="text-xs text-text-secondary tabular">{signals.length ? `TOP ${signals.length}` : ''}</span>
            </PanelHeader>
            <Caption>What is unusual right now, one card per coin, strongest first. Each card shows the rule that fired.</Caption>
            <PanelBody className="p-3">
              <SignalList signals={signals} />
            </PanelBody>
          </Panel>
        ),
        4,
      )}

      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        {panel('OI MAP', 'Where the money is now: open positions in USD, coloured by 24h price change.', () => <OiMap ctxs={universe} />, 6)}
        {panel('MOVERS', 'Biggest 24h moves among perps with at least $1M of OI and volume.', () => <Movers ctxs={universe} atCap={live.atCap} />, 6)}
      </div>

      {panel(
        'FUNDING HEATMAP',
        'Each cell is one hourly funding payment, annualised. Warm = longs pay shorts, cool = shorts pay longs.',
        () => <FundingHeatmap ctxs={universe} />,
        6,
      )}

      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        {panel(
          'FUNDING',
          'Funding is what one side pays the other every hour. Large positive = longs crowded; large negative = shorts crowded.',
          () => <FundingBoard ctxs={universe} predicted={live.predicted} />,
          5,
        )}
        {panel('BASIS', 'Premium = perp mark vs oracle (spot index). Above spot: leveraged buyers are leading.', () => <PremiumBoard ctxs={universe} />, 5)}
      </div>

      <MarketsTable />
    </PageContainer>
  )
}
