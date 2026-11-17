# Self-hosting: Hetzner + Coolify (or any VPS)

Hypertrade off Vercel, on one always-on container: the API, the built UI, the worker loops and the 15-minute jobs,
all in `scripts/server.ts`. The database stays on Supabase. Nothing in the code path depends on the host: the
container reads its config from environment variables, and Coolify is only the thing that builds and restarts it.
Plain `docker compose` on any other VPS does the same job (section 6).

## 1. What changes

| Before (Vercel) | After (one container) |
| --- | --- |
| Supabase pg_cron POSTs 13 endpoints on the Vercel API (`db/cron/schedule.sql`) | The container runs them itself (below); the Supabase schedule is turned off |
| Each call is a serverless invocation, billed in Active CPU | One process, flat monthly price |
| No worker loops (scanner, crawler, liqmap, WebSocket, desk, Telegram) | All loops run continuously |

The 15-minute jobs keep their minutes:

- **Done by worker loops already in `scripts/server.ts`:** platform tick (scanner, outcomes, prune), moves, moves agent, novelty, desk tick. These run more often than the old schedule.
- **Done by the new `cron` loop (`src/server/platform/cronLoop.ts`, on with `CRON_IN_PROCESS=1`):** collect :00/:15/:30/:45, backfill :02/:17/:32/:47, extremes :08/:23/:38/:53, intel ingest :12/:27/:42/:57, intel brief :14, lab collect :26, intel graph :29, intel watch :44 (all UTC). It calls the same routes with the same `CRON_TOKEN`, inside the process, one job at a time. `cronLoop.test.ts` fails if this list drifts from `schedule.sql`.
- `hypertrade-cleanup` (pruning pg_cron's own run log) has nothing to prune once pg_cron is off.

A failed job shows as the `cron` loop's error in `/api/health` (signed in) and in the container log as `[cron] <job> <status>`.

## 2. Server (Hetzner Cloud)

1. Hetzner Cloud console, new project, **Add server**:
   - Location: Falkenstein, Nuremberg or Helsinki (CX line is EU only).
   - Image: Ubuntu 24.04.
   - Type: **CX23** (2 vCPU, 4 GB, 40 GB). Coolify wants 2 cores and 2 GB minimum, so the smaller types are not enough.
   - Networking: public IPv4 on (Supabase's pooler and many APIs are IPv4), IPv6 on.
   - SSH key: add your public key. No password login.
   - Firewall: create one with inbound TCP 22, 80, 443, and 8000, 6001, 6002 for the Coolify dashboard until it has a domain (then close those three).
2. From your computer: `ssh root@<server IPv4>`, then `apt update && apt upgrade -y`.

## 3. Coolify

1. On the server: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`
2. Open `http://<server IPv4>:8000`, create the admin account straight away (the first visitor gets it).
3. Optional, recommended: give the dashboard its own hostname (Settings > Instance domain, e.g. `coolify.<your domain>`), then close 8000, 6001 and 6002 in the Hetzner firewall.
4. **+ New > Public Repository** (the repo is public; a private one needs Sources > GitHub App first): `https://github.com/kygura/hypertrade`, branch `master`.
   - Build pack: **Dockerfile**.
   - Ports Exposes: `8787`.
   - Domain: `https://hypertrade.<your domain>` (or leave Coolify's generated `sslip.io` address to start; it gets HTTPS too).
5. **Health check tab: leave it disabled.** Coolify's own check runs curl or wget inside the container, and the image has neither; while it is off, Coolify uses the Dockerfile `HEALTHCHECK` (a bun fetch of `/api/health`).
6. **Environment variables**, Developer view: paste them in `.env` form (section 4). None is needed at build time, so mark them runtime only (`# coolify: buildtime=false` above each, or the toggle).
7. Deploy. Watch the log for `server listening on :8787`, then `[cron] hypertrade-collect 200 ...` at the next quarter hour.
8. Auto deploy on push: a public-repo app deploys on a manual webhook (the app's Webhooks section gives the GitHub URL and secret to add under the repo's Settings > Webhooks), or switch the source to a GitHub App, which sets "Deploy on push" itself. Without either, press Deploy after a merge.

## 4. Environment variables (names only)

Copy the values from the Vercel project (Settings > Environment Variables, or `vercel env pull` on your machine). `.env.example` lists every variable with a comment; README "Railway" step 4 explains the platform ones.

**Required**

- `DATABASE_URL`: Supabase **transaction pooler** URL (port 6543). If the restricted `hypertrade_app` role is set up (README, Railway step 3), use that user.
- `APP_PASSWORD`, `SESSION_SECRET`
- `CRON_TOKEN`: the same value Supabase Vault holds as `hypertrade_cron_token`.
- `APP_URL`: the new public origin, no trailing slash.
- `CRON_IN_PROCESS=1`
- `DB_POOL_MAX=4`

**Carry over whatever the Vercel project has set**, typically: `CRON_SECRET`, `PUBLIC_MODE`, `INTEL_ENABLED` (unset means the intel jobs run, as `schedule.sql` had them on; `false` leaves them out), `ANTHROPIC_API_KEY` and the other `ANALYST_*` / provider keys, `EXA_API_KEY`, `ELFA_API_KEY`, `BGEOMETRICS_TOKEN`, `COINALYZE_API_KEY`, `X_BEARER_TOKEN`, the `INTEL_*` tuning, the `DESK_*` settings, `DESK_TELEGRAM_BOT_TOKEN`, `DESK_TELEGRAM_CHAT_ID`, `NTFY_*`, `EXTREMES_WAKE_URL`, `EXTREMES_WAKE_TOKEN`, `EXTREMES_WAKE_HEADERS`, `ROUTINE_WEBHOOK_URL`, `LAB_API_TOKEN`, `ENGINE_URL`, `ENGINE_TOKEN`, `PLATFORM_*`.

**Leave out**

- `VERCEL` and every `VERCEL_*`: Vercel sets them; `VERCEL` makes the replay, moves and signal-board code take their serverless paths.
- `PORT`: the container listens on 8787.
- `DESK_TELEGRAM_WEBHOOK_SECRET`: unset, the Telegram loop long-polls and needs no public webhook. Set, polling stays off and Telegram keeps calling the old Vercel URL.
- `MIGRATE_ON_BOOT`: only for a fresh database, and only with the owner role.

Note: the collector's hl-cycles source points at `hl-cycles-one.vercel.app`, and `DESK_CYCLES_URL` should too. If hl-cycles is down, the desk says the cycle context is unavailable and the collector records a gap. Nothing breaks.

## 5. Cutover

Do these in order, with Vercel left as it is.

1. Deploy on Coolify (section 3) and wait for one quarter hour.
2. Check: `curl -sS https://<new origin>/api/health`. Expect `"ok":true`, every `loops` entry `ok`, `cron` among them. Signed in, `store` is `pg` and `ws.state` is `open`. The container log shows `[cron] ... 200` lines.
3. Supabase SQL editor, as `postgres`: run `db/cron/unschedule.sql`. From now on only the container calls the jobs. (Until this step both call the same jobs at the same minutes, so keep the gap short.)
4. Point Vault at the new origin anyway, so a rollback is one script: `select vault.update_secret((select id from vault.secrets where name = 'hypertrade_app_url'), 'https://<new origin>');`
5. GitHub repo secret `APP_URL` = the new origin (the manual fallback workflows in `collect.yml` and `platform-tick.yml` use it).
6. DNS: an `A` record for your hostname to the server's IPv4 (and `AAAA` to its IPv6), TTL 300 while you switch. Coolify/Traefik requests the certificate once the record resolves.
7. Bookmarks and links: Telegram review links follow `APP_URL` from the next alert on.

The Vercel deployment stays paused; nothing needs changing there.

## 6. Rollback

Back to Supabase pg_cron calling a host:

1. Vault `hypertrade_app_url` to that host's origin (`vault.update_secret` as above).
2. Re-run `db/cron/schedule.sql`.
3. Stop the container (Coolify: Stop) or set `CRON_IN_PROCESS=0` and restart, so the jobs are not called twice.

Back to Vercel specifically needs the team unpaused first (vercel.com/help).

## 7. Moving to another host (under an hour)

The container needs only Docker and the env file; the database is outside it. On any Linux VPS with Docker:

```bash
git clone https://github.com/kygura/hypertrade && cd hypertrade
cp .env.example deploy/.env          # paste the values (section 4), plus DOMAIN=hypertrade.example.com; never commit it
docker compose -f deploy/compose.yml --profile tls up -d --build
docker compose -f deploy/compose.yml logs -f app   # [cron] lines at the next quarter hour
```

`deploy/compose.yml` runs the app on `127.0.0.1:8787` and, with profile `tls`, Caddy on 80/443 with an automatic certificate for `DOMAIN` (`deploy/Caddyfile`). Keep `DOMAIN` in `deploy/.env`: compose reads it from there on every command, `logs` and `down` included, and stops with an error when it is missing. Without the profile, put your own proxy in front of 8787. Then:

1. Stop the old container first (only one host should run the jobs).
2. Move the DNS record to the new IP. With TTL 300 the switch takes minutes.
3. Update `APP_URL` in `deploy/.env` and in GitHub, and Vault's `hypertrade_app_url`, to the new origin if it changed.

Another Coolify server works the same way as section 3; Coolify only adds the dashboard and the push-to-deploy.

## 8. Vercel-only code that stays (inert off Vercel)

- `api/index.ts`: `handle` from `hono/vercel` and `maxDuration = 300` are the Vercel function export. `scripts/server.ts` imports the Hono `app` directly and never touches them.
- `vercel.json`: build settings and three daily backstop crons; Vercel only.
- `isServerless()` (`src/server/platform/runtime.ts`) reads `VERCEL`; unset here, so the replay, moves and signal-board code take their always-on paths.

None of them needs removing for the move; delete them once Vercel is gone for good.

## 9. Why Hetzner over Render

Prices from the providers' own pages, read 2026-11-14, before VAT:

- **Hetzner CX23:** EUR 5.49/month plus EUR 0.50 for the IPv4. 2 vCPU, 4 GB. Flat; no request or CPU metering.
- **Render:** the always-on sizes are $7/month for 0.5 CPU and 512 MB, $25 for 1 CPU and 2 GB, $85 for 2 CPU and 4 GB. The free tier spins down. Pro workspace features add $25/month on top.

This server holds a WebSocket, a 24 h scanner ring and the loops in memory, so 512 MB is tight; the comparable Render size is $25 to $85 a month against about EUR 6 on Hetzner. Render does less ops work for you (no OS to patch); Coolify covers deploys and restarts, and `apt upgrade` plus Ubuntu's unattended upgrades cover the rest.
