# Autoresearch run, 2026-11-20 (BTC, ETH)

First run of the loop in docs/AUTORESEARCH.md. Four agents, one domain each (on-chain, derivatives, flows, price), 40 experiments each: 160 rules scored by the fixed evaluator on data pinned at 2017-01-01 → 2026-11-19 (price `cm:PriceUSD`, 10 bps slippage). Agents saw walk-forward numbers only (test blocks 2018-12-24 → 2024-11-27). The holdout (2024-11-28 → 2026-11-19) was read once, after the loop, for the tables below. Every experiment is in `autoresearch-2026-11-20.tsv`.

## What it says

- **Stance on 2026-11-19: flat on BTC and flat on ETH.** Both are in a `down` trend regime and no champion fires on either side. Flat means no firing rule has an edge here, not a bearish read.
- **No champion clears the save bar.** Over the holdout BTC buy-and-hold lost 35.6% (Sharpe −0.30, drawdown −53%) and ETH lost 52.3% (Sharpe −0.21, drawdown −68%). Six of the eight long champions are uptrend-gated; on BTC all three of those lost 10–21% in the holdout, on ETH two were about flat and one lost 7%. The one long that made money out of sample is ETH fee demand with modest MVRV (+41.8%, holdout Sharpe 1.28), and it is `weak`: its walk-forward Sharpe is 0.69 and its deflated Sharpe 0.22. Nothing here should be saved to the catalogue as it stands.
- **Shorts are thin.** The short champions that held up out of sample trade one to six times a year on a few dozen in-market days; their deflated Sharpe is 0.05–0.16 against 78–82 experiments.
- **What the agents ruled out** (walk-forward, before any holdout): contrarian fear longs (Fear & Greed < 25), MVRV-top shorts (MVRV ≥ 3, z ≥ 2), low implied volatility as a long signal, active-address and transfer-count z-scores on either side, plain time-series momentum (Sharpe 1.13, drawdown 65%), and every structural price short on BTC.

One agent's helper script was overwritten by another's at a shared scratch path, so three flows rules were logged in the derivatives slot. Those rows were moved to the flows slot and keep/discard was replayed in log order before the holdout was read; the TSV here is the corrected log.

## BTC (82 experiments, price 61881)

| slot | rule | fitness | WF Sharpe | WF max DD | holdout Sharpe | holdout return | holdout trades | deflated Sharpe | stability | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| long/price | `cm:PriceUSD rsi(14) ≥ 65 AND cm:PriceUSD vol(30) < 0.04 AND trend ∈ {up}` | 1.48 | 1.52 | -21% | -0.64 | -17.0% | 20 | 0.91 | 1.00 | fails_holdout |
| long/derivatives | `deribit:btc_dvol z(90) ≥ 1 AND trend ∈ {range,up}` | 0.98 | 0.98 | -15% | -1.01 | -20.7% | 17 | 0.47 | 1.00 | fails_holdout |
| short/flows | `fng:value raw ≥ 50 AND llama:stablecoin_cap roc(90) < 0 AND trend ∈ {down}` | 0.95 | 0.95 | -2% | -1.00 | -0.2% | 1 | 0.39 | 0.67 | fails_holdout |
| long/flows | `fng:value raw ≥ 60 AND trend ∈ {up}` | 0.89 | 1.38 | -30% | -0.23 | -10.2% | 18 | 0.82 | 1.00 | fails_holdout |
| long/onchain | `bc:miners_revenue ma_ratio(365) < -0.5 AND trend ∈ {down,range}` | 0.62 | 0.62 | -15% | untested | — | 0 | 0.15 | 0.60 | fails_holdout |
| short/onchain | `bc:tx_volume_usd z(90) ≥ 2 AND trend ∈ {down}` | 0.62 | 0.62 | -7% | 0.25 | +2.2% | 7 | 0.12 | 0.80 | weak |
| short/derivatives | `deribit:btc_dvol pctile(180) < 0.3 AND deribit:btc_dvol roc(30) < 0 AND trend ∈ {down}` | 0.50 | 0.50 | -16% | 0.35 | +8.3% | 12 | 0.10 | 0.91 | weak |

**Stance:** flat (trend `down`): no long rule fires (0 of 4); no short rule fires (0 of 3).

**30-day projection** (1000 paths, 10-day blocks, started on the 1067 past days in a `down` trend): P(higher in 30 days) 52%, median +0.8%, p10–p90 48,425 to 78,269, median drawdown along a path -14%.

| timeline | 30-day return | likelihood |
|---|---|---|
| sharp drop | below -19% | 12% |
| drift lower | -19% to -6% | 21% |
| sideways | -6% to +6% | 27% |
| drift higher | +6% to +19% | 23% |
| sharp rally | above +19% | 17% |

## ETH (78 experiments, price 1753)

| slot | rule | fitness | WF Sharpe | WF max DD | holdout Sharpe | holdout return | holdout trades | deflated Sharpe | stability | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| long/derivatives | `deribit:eth_dvol pctile(180) ≥ 0.7 AND trend ∈ {up}` | 0.82 | 0.94 | -22% | -0.12 | -6.8% | 13 | 0.43 | 0.80 | fails_holdout |
| short/onchain | `cm:CapMVRVCur raw ≥ 1.5 AND cm:FeeTotNtv z(90) < 0 AND trend ∈ {down}` | 0.78 | 0.78 | -8% | untested | — | 0 | 0.26 | 1.00 | fails_holdout |
| long/flows | `fng:value raw ≥ 60 AND trend ∈ {up}` | 0.67 | 1.43 | -35% | 0.05 | -3.7% | 14 | 0.86 | 1.00 | candidate |
| long/onchain | `cm:FeeTotNtv z(90) ≥ 1 AND cm:CapMVRVCur raw < 1.5 AND trend ∈ {up}` | 0.65 | 0.69 | -21% | 1.28 | +41.8% | 23 | 0.22 | 1.00 | weak |
| long/price | `cm:PriceUSD rsi(14) ≥ 65 AND trend ∈ {up}` | 0.64 | 1.03 | -28% | 0.12 | +0.8% | 18 | 0.53 | 1.00 | candidate |
| short/derivatives | `deribit:eth_dvol z(90) < -1 AND trend ∈ {up}` | 0.62 | 0.62 | -11% | 0.18 | +2.9% | 11 | 0.16 | 0.60 | weak |
| short/price | `cm:PriceUSD vol(30) ≥ 0.05 AND cm:PriceUSD ma_ratio(20) < 0 AND trend ∈ {up}` | 0.54 | 0.54 | -14% | untested | — | 0 | 0.09 | 0.33 | fails_holdout |
| short/flows | `fng:value raw ≥ 50 AND llama:defi_tvl roc(90) < 0 AND trend ∈ {down}` | 0.36 | 0.36 | -12% | 0.35 | +5.3% | 3 | 0.05 | 0.56 | weak |

**Stance:** flat (trend `down`): no long rule fires (0 of 4); no short rule fires (0 of 4).

**30-day projection** (1000 paths, 10-day blocks, started on the 1181 past days in a `down` trend): P(higher in 30 days) 48%, median -2.1%, p10–p90 1,261 to 2,401, median drawdown along a path -19%.

| timeline | 30-day return | likelihood |
|---|---|---|
| sharp drop | below -26% | 12% |
| drift lower | -26% to -9% | 24% |
| sideways | -9% to +9% | 29% |
| drift higher | +9% to +26% | 17% |
| sharp rally | above +26% | 17% |

## Reading it

- The loop works as built: the walk-forward ranked, the holdout refused. A long-only rule set fitted through 2024 meeting a two-year decline is the failure the holdout exists to catch.
- The projection is close to a coin flip with a wide range, which is what a block bootstrap of a `down` regime gives: such regimes hold both the continuation and the sharp bounce.
- Next run, in order of likely value: derivatives history that reaches into the walk-forward (`ht:funding` and `okx:oi` start too late to be scored today), a richer regime label than the three-state trend (tradespace's range/capitulation/bottoming labels), and more assets so a rule is tested on more than two price paths.
