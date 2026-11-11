import type { VectorResponse } from '../../../shared/vector'
import { fmtSigned } from '../../lib/format'
import { MetricStat } from '../MetricStat'
import { fmtYield } from './format'

// MacroStrip (hl-cycles DESIGN §14.4.6) — rates, dollar and the BTC·SPX
// correlation as context. No colour by sign: context, not a verdict.

export function MacroStrip({ macro }: { macro: VectorResponse['macro'] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
      {/* dollarVs200d is already in percent. */}
      <MetricStat label="Dollar vs 200D" value={fmtSigned(macro.dollarVs200d, '%', 1)} />
      <MetricStat label="US 10Y" value={fmtYield(macro.us10y)} />
      <MetricStat label="US 2Y" value={fmtYield(macro.us2y)} />
      <MetricStat label="Fed funds" value={fmtYield(macro.fedFundsUpper)} />
      <MetricStat label="Curve 10Y−2Y" value={fmtSigned(macro.curve, '', 2)} />
      <MetricStat label="BTC·SPX corr 30D" value={fmtSigned(macro.spxCorr30d, '', 2)} />
    </div>
  )
}
