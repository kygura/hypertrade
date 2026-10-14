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
- [ ] V Verification gate — folded into phase 7 V (never ran; baseline 2026-10-14: 1280 pass / 1 fail analyst.test.ts:394, typecheck/build/check:api green)

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
- [ ] R1 Contract + 010_research.sql + store (Pg/Memory) + research.ts engine — sonnet — deps S
- [x] T Thresholds + confluence + graph diff-review + dead client fns + analyst.test fix — sonnet — deps S
- [ ] R2 Routes + auto trigger in ingest — sonnet — deps R1
- [ ] U5 ResearchPanel, chip action, timeline event, confluence badge — opus (ui-impl) — deps D2, R1
- [ ] V Verification gate (covers phase 6 too) — reviewers, drift, test/typecheck/build/check:api

## Decisions so far
- P0: Flow A–E already merged on feat/flow-scout; only V missing. Confluence found absent from every materiality formula. Exchange inflows stay out (no free source). Telegram /ask stays Desk.
- S (fable, adopted): no fetch tool (searches ≤ 8 via per-call maxUses; SSRF surface stays closed); observed evidence must cite a URL from the provider's own search results + number in its excerpt, else hypothesis; 45 s research deadline; DB `running` lock not process flag; auto research = own last ingest stage; one `materiality(parts,k)` seam in diff.ts, own signal excluded from k; researchId joined at read time; graph refresh already never deletes → only add stale-edge removal (non-seed/manual).
- D2 (fable): RESEARCH full-width row under FLOW; "see research" scrolls to the card on `/`; confluence badge ×1.25 only when > 1. Gaps closed by planner in S1: POST accepts `flagId` (chip runs stay trigger "manual"), research AssetEvents carry `research`.
- R1 review (opus risk + reliability): the provenance check was number-only against titles. Now observed = cited_text overlap ≥ 50 % + exact numbers; found needs an observed claim; 8 searches per run incl. retries; failed calls count toward the $ cap; DB-clock stale lock; limits count running|found|no_cause only. Fix round 1 sent to the R1 worker.
- T: k = 1 + other distinct sources (6 h window); Alert has no confluence field (avoids a migration clash), so the badge is digest-only; heatmap row materiality left as is.
- T review (opus reliability): per-asset deletes dropped cross-target and refused-but-reasserted edges → one run-level delete after all upserts, keep = union incl. well-formed refusals, never delete when an endpoint failed. Same-run flag classes precomputed (symmetric k). Held exposure floored at WATCH_FLOOR. Fix round 1 sent to the T worker.
