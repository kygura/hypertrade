# Flow data sources (research, 2026-10-14)

Probe host was in Spain (not US), so US-geoblock claims are doc/community-sourced, NOT empirically verified from Vercel iad1. Re-test from a deployed function.

## 1. Coinalyze (https://api.coinalyze.net/v1, spec: https://api.coinalyze.net/v1/doc/api-spec.json, docs: /v1/doc/)
- Free, key required (no key -> 401 `Invalid/Missing API key`, verified). Key from https://coinalyze.net/account/api-key/ ; send as header or query `api_key`.
- Rate limit: 40 calls/min per key; 429 with `Retry-After`. Each symbol in a multi-symbol call (max 20) costs one call.
- Interval: 1min,5min,15min,30min,1hour,2hour,4hour,6hour,12hour,daily. Intraday retention only 1500-2000 datapoints (older deleted daily); daily kept forever. Ascending order.
- Common params: `symbols` (csv, <=20), `interval`, `from`, `to` (unix SECONDS, inclusive); `convert_to_usd=true|false` on open-interest(-history) and liquidation-history.
- Endpoints (response = `[{symbol, history:[{t,...}]}]`, t = interval start, seconds):
  - GET /open-interest-history -> o,h,l,c
  - GET /funding-rate-history -> o,h,l,c (percent)
  - GET /predicted-funding-rate-history -> o,h,l,c
  - GET /liquidation-history -> l (longs liquidated vol), s (shorts)
  - GET /long-short-ratio-history -> r, l (% long), s (% short)
  - GET /ohlcv-history -> o,h,l,c,v, **bv (buy volume; sell = v-bv)**, tx, btx (buy trades). Only where market `has_buy_sell_data`.
  - Snapshots: /open-interest, /funding-rate, /predicted-funding-rate -> [{symbol,value,update(ms)}]
  - Lists: /exchanges [{name,code}], /assets [{id,symbol,name,asset_category}], /future-markets [{symbol,exchange,symbol_on_exchange,base_asset,quote_asset,is_perpetual,margined,expire_at,oi_lq_vol_denominated_in,has_long_short_ratio_data,has_ohlcv_data,has_buy_sell_data}], /spot-markets [{symbol,exchange,symbol_on_exchange,base_asset,quote_asset,has_buy_sell_data}]
- Symbols: doc examples `BTCUSDT_PERP.A` (suffix `.A` = aggregated across exchanges) and `BTCUSD_PERP.0` (per-exchange, suffix = exchange code), `BTCUSD.C`. Discover exact codes via /future-markets and /exchanges.
- Spot: yes, /spot-markets + /ohlcv-history on spot symbols (with buy/sell volume where flagged) -> spot-vs-perp volume feasible.
- Hyperliquid: NOT confirmable without a key (list endpoints need auth; coinalyze.net site 403s bots). Call /exchanges once with a key and look for Hyperliquid. Do not assume.
- Example: `GET /v1/liquidation-history?symbols=BTCUSDT_PERP.A&interval=1hour&from=1791990000&to=1791996000&api_key=KEY`
- 15 min cron: use `15min` interval; 20 symbols/call but 20 calls cost -> 40/min cap means ~2 full 20-symbol batches/min per endpoint family. Budget accordingly.

## 2. Geoblocking from US IPs
- Binance fapi.binance.com: public endpoints return HTTP 451 "restricted location" from restricted/US IPs; community reports of exactly this on Vercel: https://community.vercel.com/t/binance-api-calls-on-vercel/29895 (also Railway US regions). Not stated in an official Binance page I could fetch. Treat as BLOCKED on iad1. My Spain probe returned 200 for all three endpoints below.
  - GET /futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=2 -> symbol,longShortRatio,longAccount,shortAccount,timestamp
  - GET /futures/data/takerlongshortRatio?symbol=BTCUSDT&period=5m -> buySellRatio,buyVol,sellVol,timestamp
  - GET /futures/data/openInterestHist?symbol=BTCUSDT&period=5m -> sumOpenInterest,sumOpenInterestValue,CMCCirculatingSupply,timestamp
  - periods 5m..12h(+1d), limit default 30 max 500, only latest 30 days, 1000 req/5min/IP, weight 0 (https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Long-Short-Ratio)
- Bybit api.bybit.com v5: OFFICIAL — HTTP 403 "You are using U.S IP" and retCode 10009 "Access is currently unavailable for your region" (https://bybit-exchange.github.io/docs/v5/error). BLOCKED.
- OKX https://www.okx.com/api/v5/public/*: 200 from Spain; no official US-block statement found for public data. UNVERIFIED from US; test from Vercel. (Trading is restricted for US users; public market data likely open.)
- Mitigation: Vercel function region can be set to a non-US region (e.g. fra1/sin1/hnd1) via `regions` in vercel.json — egress IP geolocation is what is checked.

## 3. Hyperliquid liquidations
- https://api.hyperliquid.xyz/info (POST JSON, keyless, 1200 weight/min/IP; https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits). `metaAndAssetCtxs` works (OI, funding, volume per coin).
- No market-wide REST liquidation feed. Liquidations appear only per user (`userFills`/WS `WsUserEvent.liquidation`, and `userNonFundingLedgerUpdates`) via https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions. Market-wide needs WS trades/user streams or third-party (Coinalyze if it covers HL).

## 4. CEX inflows/outflows per coin
- None free and keyless. CryptoQuant API -> 401 without token; Glassnode -> 401; DefiLlama derivatives overview -> 402 (paid); DefiLlama has no CEX netflow anyway (only TVL/CEX reserves pages, not flows API). Arkham needs key. Conclusion: no free source.
