# Tasks — Intel (LLM trading tools)

Harness: Claude Code (remote). Planner: claude-opus-5-5. Evidence: ~/.agentic-build/evidence.md (DeepSWE v1.1: Opus 5 74 / $11.84, Fable 5 70 / $13.41, Sonnet 5 54 / $26.40; Haiku no row).
Roster: fable, opus, sonnet, haiku — all Anthropic, native Agent tool, no bridges. Provider diversity impossible; reviewer = different family from implementer.

| Role | Model | Effort | Note |
|---|---|---|---|
| planner | opus (self) | — | fixed |
| discussion | fable | default | different family from planner |
| designer | opus | default | degraded: no visual-lane evidence |
| heavy | opus | default | top logic score, cheapest within 4 pts |
| worker | opus | default | cheapest within 4 pts of best (sonnet dominated: lower score, higher cost) |
| ui-impl | opus | default | same family as designer |
| grunt | haiku | default | unverified, bounded tasks only |
| reviewer | fable (opus work) / opus (haiku work) | default | different family |
| drift-check | haiku | low | no visual evidence anywhere |

Destination: `/` becomes the Intel Terminal (SPEC.md § Intel): all eight modules of the LLM trading tools brief, wired end to end, tested, typecheck/build green.

## Tasks
- [x] P0 Plan — SPEC.md § Intel, src/shared/claims.ts, TASKS.v2.md archived — opus (planner) + fable second opinion
- [x] D1 Design pass → DESIGN-terminal.md — opus — done
- [x] T1 Contract: 007_intel.sql, src/shared/intel.ts (all API types), IntelStore (Pg + Memory), positions.ts — opus — done
- [x] T2 LLM: completeStructured + cache + trace + cap, provider web-search opt-out, claims validator — opus — done
- [x] T3 Governor refactor: evaluateRisk + DeskService.submitOperatorOrder — opus (heavy) — done
- [x] T4 Snapshot store + normalize/diff + terminal brief + collect/backfill hooks — opus — deps T1, T2
- [x] T5 Graph + cluster + ingest adapters + calendar — opus — deps T1, T2
- [x] T6 Mapper + priced-in + catalysts + feedback + notify — opus — deps T4, T5
- [x] T7 Journal — opus — deps T1, T2
- [x] T8 Theses + screener — opus — deps T4
- [x] T9 Copilot — opus — deps T1, T2, T3
- [x] T10 Docwatch — opus — deps T6
- [x] T11 Routes + cron wiring + workflow + api mount + auth READ_PATH — opus — deps T4–T10
- [x] U1 UI shell: routes, nav, TerminalTabs, lib/intel.ts — opus (ui-impl) — deps D1, T1
- [x] U2 Terminal page — opus (ui-impl) — deps U1
- [x] U3 Journal + Theses + Query pages — opus (ui-impl) — deps U1
- [x] U4 Order + Watch pages — opus (ui-impl) — deps U1
- [x] T12 README + DESIGN.md §5/§10.2/§13 touch-ups — haiku — deps U2–U4
- [x] V1 Verification gate — reviewers (fable), drift (haiku), tests/typecheck/build/check:api

## Decisions so far
- P0: baseline 769 pass, typecheck green. Workers do not commit; planner commits per task with explicit paths. Native Claude workers only.
- P0 (fable second opinion adopted): snapshot written inside /cron/collect; metric-specific normalization (price/OI hourly-σ scaled, funding/premium level z, volume/depth log-ratio); separate leased cron routes gated by INTEL_ENABLED; reuse DESK_WATCH_ADDRESS + Desk model resolution; static macro calendar; only UI open logs a review; governor refactored into evaluateRisk, copilot via submitOperatorOrder (always confirm); DSL-only screener; real routes for sub-tabs.
- T2 (opus): completeStructured never throws; StepOptions.webSearch opt-out (default on); emit tool + fenced-JSON fallback + one retry; cap via callsSince. 786 green.
- T3 (opus): evaluateRisk extracted, evaluateOpen output identical; previewOperatorOrder/submitOperatorOrder(order, {previewHash}, by); records in desk_proposals decidedBy operator:copilot. Review (fable): HIGH double-exec race → fixed with atomic takeState + mutex; `by` required; resolvedRiskPct; Desk.tsx renders copilot rows. Open: one testnet smoke for no-target normalTpsl.
- T1 (opus): 16 tables, lists as jsonb; alert dedupe key (kind, ref, asset, time_window); HttpsUrlSchema blocks IP/local hosts (SSRF); aligned to DESIGN-terminal §13 (design doc renamed to contract names). 836 green.
- D1 (opus): OBS gray / HYP info-blue badges; 4-char sub-tabs no scroll; nav ▣ TERM; review once per tab per 5 min; order confirm Level 2 with venue badge, no Money tier.
- Wave 2 launched in worktrees: T4, T5, T7, T8, T9, U1.
- Waves 2–3 (opus, worktrees): T4 snapshot/normalize/brief, T5 graph/cluster/ingest, T6 mapper/catalysts/feedback, T7 journal, T8 theses/screener, T9 copilot, T10 docwatch, U1–U4 UI; T11 wiring (routes, cron, workflow, auth, client↔route contract test). Merge conflicts only in the UI barrel and format.ts (additive, resolved).
- V1 reviews (fable): risk — ReDoS in HTML/RSS scanning (HIGH), hostname-only SSRF, unbounded ingest bodies, raw 500s, prompt-injection integrity; reliability — UI baseline could be minutes old (z inflation), h-cap inflation, unreadable rate deltas, mapper budget/dedupe, catalyst ordering; finalizer — feedback report unreachable, Vercel cron bypassing INTEL_ENABLED, catalyst dampening, thesis recheck on alerts, journal weekly schedule, graph refresh without web search, Telegram backoff; drift (haiku) — confirm copy not irreversible (MUST-FIX); ponytail — ~180 lines of duplicated helpers.
- V1 loops 1–2 (opus): all fixed except drift B2 (lg/xl are type sizes, not breakpoints; code already follows DESIGN.md). Gate: 1147 pass, typecheck, build, check:api green. Browser run without DB: all 7 routes render on desktop and mobile, no page errors, every panel in a named state.
- Open: HL journal trades have no stop source (R blank); no-target normalTpsl needs one testnet smoke; no DNS pinning (TOCTOU noted); calendar dates must be checked yearly; not yet exercised against a live Postgres + LLM.
- Follow-up (2026-10-14): live run against a local Postgres 16 + live Hyperliquid (all routes and cron jobs exercised, a paper order confirmed, 19 responses zod-validated) → 4 bugs fixed; store.pg.test.ts Pg/Memory parity suite (runs with INTEL_PG_TEST_URL); macro calendar verified against Fed/BLS (5 dates corrected); HL stops captured during collect (migration 008) so HL journal trades get R; docwatch pins the vetted IP (node:https lookup); level/ratio metrics flagged only when changed since the baseline. Gate: 1164 pass + 6 PG-gated, typecheck, build, check:api green.
- Still open: live LLM provider run (needs a key); one HL testnet smoke for no-target orders (needs testnet credentials).

---

# Tasks — Flow (phase 6, "Flow + Scout" quant gaps)

Harness: Claude Code (local). Planner: claude-sonnet-5-5. Roster: native Anthropic only (fable, opus, sonnet, haiku); no bridges (user rule). Reviewer = different family / fresh context.

| Role | Model | Effort |
|---|---|---|
| planner | sonnet (self) | — |
| discussion | opus / fable | default |
| designer | fable | default |
| heavy / worker / ui-impl | opus | default |
| reviewer | fable (opus work) | default |
| drift-check | haiku | low |

Destination: SPEC.md § Flow (F0–F3) built into the Intel Terminal; `/` gains the flow heatmap + detector chips, `/asset/:coin` exists, Telegram /digest + 👍/👎 work, LLM lines pass the number validator, $ cap enforced; test/typecheck/build/check:api green.

## Tasks
- [x] P0 Plan — SPEC.md § Flow, docs/research/flow-sources.md (sonnet research), opus second opinion — sonnet (planner)
- [x] D1 Design pass → DESIGN-terminal.md §15 — fable
- [x] A Contract + pure quant: 009_flow.sql, shared/intel.ts types, IntelStore flow methods, windows.ts, flows.ts — opus — deps P0
- [x] B LLM guards: numbers.ts validator wired at the claim layer, $ daily cap in llm.ts — opus — deps P0
- [x] C Telegram: /digest + fb callbacks + alert actions — opus — deps P0 (uses `via` enum from A; merge after A)
- [x] D Coinalyze collector in collect + routes heatmap/asset/flows + detector events in brief/mapper push — opus — deps A
- [x] E UI: FlowHeatmap, DetectorChips, AssetPage (timeline + graph), cap copy — opus (ui-impl) — deps A, D1
- [x] V Verification gate — folded into phase 7 V (done 2026-10-14) (never ran; baseline 2026-10-14: 1280 pass / 1 fail analyst.test.ts:394, typecheck/build/check:api green)

## Decisions so far
- P0: Coinalyze only (Binance/Bybit US-blocked from Vercel iad1); exchange inflows out of scope; robust σ + non-overlapping windows; detectors ranked in their own materiality list; existing Telegram callback branch extended; no Codex (user).

---

# Tasks — Scout (phase 7: research + scorer gaps on `/`)

Harness: Claude Code (local). Planner: claude-opus-5-5 (P0, S); claude-sonnet-5-5 from D2 on (2026-10-14 resume). Roster: native Anthropic only (fable, opus, sonnet, haiku), no bridges (user rule). Reviewer = different family / fresh context.

| Role | Model | Effort |
|---|---|---|
| planner | opus → sonnet (self) | — |
| discussion | fable | medium |
| designer | fable | medium |
| worker | sonnet | medium (escalate: high → opus) |
| heavy | opus | medium |
| ui-impl | opus | medium |
| reviewer | opus (sonnet work), fable (opus work) | medium |
| grunt / drift-check | haiku | high / low |

Destination: SPEC.md § Scout S0–S2 — Research panel on `/`, auto research on unexplained flags, digest/alert thresholds, confluence, graph diff-review; full gate green.

## Tasks
- [x] P0 Plan — SPEC.md § Scout; user chose research on `/` (2026-10-14) — opus
- [x] S Second opinion on S0 — fable
- [x] D2 Design pass → DESIGN-terminal.md § 16 — fable
- [x] R1 Contract + 010_research.sql + store (Pg/Memory) + research.ts engine — sonnet — deps S
- [x] T Thresholds + confluence + graph diff-review + dead client fns + analyst.test fix — sonnet — deps S
- [x] R2 Routes + auto trigger in ingest — sonnet — deps R1
- [x] U5 ResearchPanel, chip action, timeline event, confluence badge — opus (ui-impl) — deps D2, R1
- [x] V Verification gate (covers phase 6 too) — reviewers, drift, test/typecheck/build/check:api

## Decisions so far
- P0: Flow A–E already merged on feat/flow-scout; only V missing. Confluence found absent from every materiality formula. Exchange inflows stay out (no free source). Telegram /ask stays Desk.
- S (fable, adopted): no fetch tool (searches ≤ 8 via per-call maxUses; SSRF surface stays closed); observed evidence must cite a URL from the provider's own search results + number in its excerpt, else hypothesis; 45 s research deadline; DB `running` lock not process flag; auto research = own last ingest stage; one `materiality(parts,k)` seam in diff.ts, own signal excluded from k; researchId joined at read time; graph refresh already never deletes → only add stale-edge removal (non-seed/manual).
- D2 (fable): RESEARCH full-width row under FLOW; "see research" scrolls to the card on `/`; confluence badge ×1.25 only when > 1. Gaps closed by planner in S1: POST accepts `flagId` (chip runs stay trigger "manual"), research AssetEvents carry `research`.
- R1 review (opus risk + reliability): the provenance check was number-only against titles. Now observed = cited_text overlap ≥ 50 % + exact numbers; found needs an observed claim; 8 searches per run incl. retries; failed calls count toward the $ cap; DB-clock stale lock; limits count running|found|no_cause only. Fix round 1 sent to the R1 worker.
- T: k = 1 + other distinct sources (6 h window); Alert has no confluence field (avoids a migration clash), so the badge is digest-only; heatmap row materiality left as is.
- T review (opus reliability): per-asset deletes dropped cross-target and refused-but-reasserted edges → one run-level delete after all upserts, keep = union incl. well-formed refusals, never delete when an endpoint failed. Same-run flag classes precomputed (symmetric k). Held exposure floored at WATCH_FLOOR. Fix round 1 sent to the T worker.
- R1 + T merged (fixes d755cba, d267746). Pg parity still unrun: no Postgres or docker on this host. The Pg SQL is read-reviewed only, and V must name this gap. Search fee is $0.01/search (ponytail note in llm.ts). R2 and U5 launched in parallel worktrees.
- R2 review (opus reliability + resilience). Live heatmap flag ids embedded request time, so researchId never joined in prod; fix = carry the stored episode id. Per-flag join queries → one batched query that fails soft. Timed-out steps now record a pessimistic cost. Both daily limits count running|found|no_cause + failed with cost > 0. Auto: one attempt per flag per UTC day, stop on capped, abort signal threaded, start only with deadline + 15 s left, collector_runs `intel:research`. Fix round 2 sent.
- R2 fixes 0243ee1 + 0211cb5 (asset stored as typed, matched case-insensitively; kPEPE-safe). U5 fixes 4cf399b (merge prefers non-running copy, researchGate reducer, gate clearing). Both merged → 43d58d7. V launched: finalizer + render, phase 6 4R (risk/reliability/resilience), standards+spec, ponytail.
- V results. Spec: every F/S item implemented. Phase 6 reviews: the validator harvested digits from ids/timestamps; advice guard too narrow; thesis claims and LLM headlines unvalidated; zero-heavy liq history exploded z; funding level floor too small; flip-back swallowed; partial flow-loop failure re-pushed; migration 009 undocumented; heatmap failed whole on one table. Ponytail: kept the OI/funding endpoints (spec F0.1) and the researchGate reducer (testability); deferred strictNumbers dedupe and lazy windows. Accepted: parallel journal workers can overshoot the $ cap by ≈ one call each. Fix round: W1 (validator/LLM/docs) + W2 (flow math/resilience) in parallel worktrees.
- V done (089a5c9): 1408 pass / 6 skip / 0 fail, typecheck, build, check:api green; browser render of `/` and `/asset/BTC` with fixtures passes (the asset-page recharts crash was found by render only). Open: Pg parity tests have never run (no Postgres on host); `upsertEvents` sql(rows) and research SQL are read-reviewed only.

---

# Tasks — Signal evidence (phase 9, FEATURES.md)

Harness: Claude Code (local). Planner: claude-opus-5-5. Roster: native Anthropic only (fable, opus, sonnet, haiku), no bridges (user rule). Reviewer = different family / fresh context.

| Role | Model | Effort |
|---|---|---|
| planner | opus (self) | — |
| heavy | opus | medium |
| worker | sonnet | medium (escalate: high → opus) |
| reviewer | fable (opus work), opus (sonnet work) | medium |
| grunt | haiku | high |

Destination: FEATURES.md §§ 1–7 implemented where marked in scope. Every signal, novelty hit and thesis change carries facts (n, clusters, interval, trial count), never a verdict. Nothing places orders, gates the operator or nags. test/typecheck/build/check:api green.

## Tasks
- [x] PS1 Lab rule authoring from intent + global trial counter (FEATURES.md § 1, § 5) — worker — deps none
  - Steps: `lab_author_rule {intent, asset?, direction?}` in `src/server/lab/tools.ts` + `service.ts`; strong-tier `completeStructured` (`src/server/intel/llm.ts`) returns 1–3 `Rule` candidates (prompt: fewest conditions, round thresholds, no near-duplicate filters); validate feature ids against the metric catalogue, one repair round, then fail closed; evaluate each with the explicit-rule path (`lab_evaluate_rule` logic); append each evaluated candidate to a persistent trial log (`lab_trials`: n, at, rule id, intent, verdict level) in `LabStore` (Pg via the next free migration, memory, JSON file); return candidates with readable text, evaluation and `idea #n of N`; write nothing to the catalogue (the operator saves with `lab_catalogue_save`, unchanged bar). Catalogue list shows `idea #n of N` for rules found in the log.
  - Files: `src/server/lab/{tools,service,store,types}.ts`, `db/migrations/0NN_lab_trials.sql`, new `src/server/lab/author.test.ts` (+ recorded LLM fixture).
  - Done: `bun test src/server/lab/author.test.ts`. An unknown feature id is rejected after one repair round; every candidate increments the counter; the catalogue is unchanged after the call; the counter survives a store reload.
- [x] PS2 Clustered ledger stats (FEATURES.md § 2, platform part) — worker — deps none
  - Steps: `groupStats` adds `clusters`, the count of distinct buckets `floor(createdAtMs / max(1 day, horizonMs))`, and computes `meanNet`/`ci95` over cluster means (t-interval on clusters, null below 5 clusters); `LedgerStatsSchema` gains `clusters`; the scanner's `edgeBasis: "ledger"` requires `clusters ≥ PLATFORM_EDGE_MIN_N` instead of `n`; SPEC.md § Platform P0.10/P0.14 updated.
  - Files: `src/server/platform/stats.ts`, `src/shared/platform.ts`, `src/server/platform/scanner.ts`, `SPEC.md`.
  - Done: `bun test src/server/platform/stats.test.ts`, with a new case where 20 outcomes created the same UTC day count as 1 cluster and give `ci95` null. Plus `bun run check:api`.
- [x] PS3 Lab event-study screen with parity test (FEATURES.md § 2, § 3) — heavy — deps PS1 (trial counter)
  - Steps: `lab_event_study {rule, coins?, stopAtr, targetAtr, slippageBps?}`: replay the rule per coin on daily candles + funding (the `ht` provider data), coins default to HL perps with ≥ 365 daily bars; entry at the signal close, stop wins an ambiguous bar, stop fills at the worse of stop and open; R net of fees, slippage and funding over the hold; cooldown = horizon; cluster by ISO week; verdict `insufficient` (< 30 weeks) / `rejected` (upper95 < 0) / `clear`; print train/holdout (last 30%) as facts and the survivorship note; record a trial.
  - Files: new `src/server/lab/engine/eventStudy.ts` + test, `src/server/lab/{tools,service}.ts`.
  - Done: `bun test src/server/lab/engine/eventStudy.test.ts`. Hand-checked R incl. funding; ambiguous bar scored as stop; weekly clustering; the three verdict thresholds; **parity**: entry days per coin equal the days where `ruleFiresAt` on truncated data first fires after cooldown.
- [x] PS4 Evidence line on platform alerts and detail (FEATURES.md § 5) — worker — deps PS2
  - Steps: build `ledger <h>: n <n> · <k> clusters · <mean>% (<lo>…<hi>) · edge <basis>` from `groupStats` for the opportunity's setup kind at the 24h horizon (interval omitted below 5 clusters); append it to the `Ready:` alert body and expose it on the opportunity detail.
  - Files: `src/server/platform/alerts.ts`, `src/server/routes/platform.ts`, `src/shared/platform.ts`.
  - Done: `bun test src/server/platform/alerts.test.ts`, with a new case asserting the facts line in the sent body for a seeded ledger and `n 0` for an empty one.
- [x] PS5 Novelty detector (FEATURES.md § 4) — heavy — deps none
  - Steps: pure `novelty(daily)` (families, new vs joint extremes, p1/p99 by linear interpolation, pctRank with half ties, 365-bar and 90-value minimums, OI only with ≥ 365 days) and `admit` (dedupe per coin/bar, push new extremes only, 3-day cooldown either side, 3 pushes per run newest bar first, retry undelivered for 3 days); daily `novelty` loop in `scripts/server.ts` gated on liquidity tier + data sufficiency; daily inputs from `candles` (1d), `funding`, `observations` `hl.oi.<COIN>`; store entries (next free migration + `PlatformStore` memory/pg, 365-day prune); `NOVEL:` alert via the platform notifier; `GET /api/platform/novelty`; a 365-day replay script printing entries/day and pushes/day.
  - Files: new `src/server/platform/novelty.ts` + test, `scripts/server.ts`, `src/server/platform/{store,store-memory,store-pg,alerts}.ts`, `src/server/routes/platform.ts`, `src/shared/platform.ts`, `db/migrations/0NN_novelty.sql`.
  - Done: `bun test src/server/platform/novelty.test.ts`. A fixture coin with an engineered funding extreme yields a pushed `new_extreme`; a two-family p99 breach yields a journal-only `joint_extreme`; cooldown and the run cap suppress. Plus the PGlite migration test.
- [x] PS6 Thesis watch: transitions, drift, "no longer holds" alert (FEATURES.md § 6) — worker — deps none
  - Steps: in `checkThesis`, diff new claim/invalidation statuses against the stored ones; append `{ts, checks:[{status, value}]}` to a `history` jsonb column (next free migration, capped at 365 entries); on `supported → contradicted` or `clear → triggered` send one alert through `sendIntel`: `Premise no longer holds: <text>` + `<check in words>: now <value> (<source>, <ts>)`, no P&L, no advice; the cron brief rechecks every thesis each run (not only flagged assets); the Theses page shows per-premise history.
  - Files: `src/server/intel/thesis.ts`, `src/shared/intel.ts`, `src/server/intel/store.ts` (+ pg), `src/server/intel/terminal.ts`, `src/ui/pages/terminal/Theses.tsx`, `db/migrations/0NN_thesis_history.sql`.
  - Done: `bun test src/server/intel/thesis.test.ts`. A supported claim turning contradicted sends exactly one alert whose text contains "no longer holds" and no advice words (reuse the claim validator's advice guard); an unchanged recheck sends none; history grows by one entry per check.
- [x] PS7 ntfy channel + macro label tag (FEATURES.md § 7) — grunt — deps none
  - Steps: `createNotifier` adds ntfy (`NTFY_TOPIC`, `NTFY_SERVER` default `https://ntfy.sh`, `NTFY_TOKEN`; headers Title/Priority/Click as printable ASCII ≤ 250 chars; body ≤ 4000; priority quiet 2, info 3, warn 4, critical 5); README env list; the scanner adds tag `macro:<FOMC|CPI> <today|in 1 day|1 day ago>` from `calendarEvents` (±1 calendar day), with no score or status effect.
  - Files: `src/server/desk/notify.ts` + new `src/server/desk/notify.test.ts`, `src/server/platform/scanner.ts` (+ test), `README.md`.
  - Done: `bun test src/server/desk/notify.test.ts src/server/platform/scanner.test.ts`. The ntfy request carries the expected URL/headers and strips non-ASCII; a scan on a CPI-eve date tags `macro:CPI in 1 day` and the score is unchanged.

### Deferred / backlog (out of scope for now)
- [x] PS-B1 Platform setups as schemas (FEATURES.md § 1): the four intraday setups are `SetupSchema` data in `src/server/platform/setups.ts`, compiled into the one predicate the scanner calls; the hardcoded `setupsFor` is gone. Own minimal schema, not the Lab Rule (that has only `<`/`>=` over daily columns with a fixed direction and threshold; the setups need |x|, ≤, same-sign, sign-derived direction and per-tier thresholds). Parity as perpsignal T9 (239/239 there): 80000/80000 setup decisions on 20000 synthetic boundary bars identical before the deletion, frozen as `fixtures/setups-parity.json`. Adds `PLATFORM_SCAN_UNIVERSE` (PS-B5 syntax; unset = every live coin).
- [ ] PS-B2 DEFERRED Near-miss "why not" (FEATURES.md, other ideas): needs a per-condition gate list on platform setups (after PS-B1).
- [ ] PS-B3 BACKLOG Condition funnel for authored rules (FEATURES.md, other ideas): coin-days surviving each condition, bottleneck marked; after PS1/PS3.
- [ ] PS-B4 DEFERRED Stop/target/invalidation expressions and categorical regime conditions on Lab rules (FEATURES.md § 1): PS3 takes `stopAtr`/`targetAtr` as tool args instead; revisit if authored rules need structural stops.
- [x] PS-B5 Universe filters for `lab_event_study` and novelty: top-N by liquidity, a narrative-sector filter (AI, Privacy, Stablecoin, Perp DEX, ...) and a "my markets" set (BTC, ETH, HYPE, SOL, XPL, LIT, ZEC). The LLM tags each coin with its sectors once and caches the result in the store, refreshed when new coins are listed. Tags are not re-derived on each call, and they only filter the universe, never score it. This also bounds the HL request volume of the all-perps default.

## Decisions so far
- P0 (2026-10-18): ideas carried from a retired sibling prototype into FEATURES.md. Static macro calendars, relative liquidity tiers and replay parity are already covered; the vault, Bonferroni screen and promotion/demotion are deliberately not ported (FEATURES.md § 2 rationale). Seed setups' screens predate the reject-only rule and are kept as history only (FEATURES.md appendix).
