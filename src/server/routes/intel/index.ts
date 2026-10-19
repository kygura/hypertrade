import { Hono } from "hono";
import * as db from "../../db.js";
import { loadDeskConfig } from "../../desk/config.js";
import { createNotifier, type Notifier } from "../../desk/notify.js";
import type { CopilotDeps } from "../../intel/copilot.js";
import type { DocwatchDeps } from "../../intel/docwatch.js";
import type { GraphRefreshDeps } from "../../intel/graph.js";
import { deskFillLoader, hlFillLoader, journalStopFor, snapshotEntryState, type JournalDeps } from "../../intel/journal.js";
import type { TelegramIntel } from "../../desk/telegram.js";
import { deepLink, routeEntities, type MapperDeps } from "../../intel/mapper.js";
import type { IntelIngestDeps } from "../../intel/runIngest.js";
import type { ReadClient } from "../../intel/screener.js";
import { focusAssets } from "../../intel/snapshot.js";
import { recheckAll, type ThesisDeps } from "../../intel/thesis.js";
import { buildBrief, defaultTerminalDeps } from "../../intel/terminal.js";
import { defaultDeskService } from "../desk.js";
import { getCtxs } from "../hl.js";
import { createAlertsRoutes } from "./alerts.js";
import { createFlowRoutes } from "./flow.js";
import { createGraphRoutes } from "./graph.js";
import { createJournalRoutes } from "./journal.js";
import { createOrderRoutes } from "./order.js";
import { createQueryRoutes } from "./query.js";
import { createResearchRoutes } from "./research.js";
import { createTerminalRoutes, type TerminalRouteDeps } from "./terminal.js";
import { createThesesRoutes } from "./theses.js";
import { createWatchRoutes } from "./watch.js";

// /api/intel — the Intel aggregator (SPEC.md § Intel I1, I2). Mounts every
// sub-router on one Hono app; auth is the global gate (session cookie, GET
// also accepts the LAB_API_TOKEN bearer via READ_PATH in auth.ts).
//
// defaultIntelDeps(env) builds the production wiring once per process. It
// does no I/O when built: stores and clients connect on first query, and the
// Desk service is only constructed when a request first needs it.

export interface IntelDeps extends TerminalRouteDeps {
  /** Built on first use (the Desk store is only opened when a journal request needs it). */
  journal: () => JournalDeps;
  thesis: ThesisDeps;
  copilot: () => CopilotDeps;
  docwatch: DocwatchDeps;
  /** Screener read client; defaults to DATABASE_URL_READONLY or the main sql(). */
  queryClient?: () => ReadClient;
}

/** Held ∪ watched assets, deduped. */
export async function intelTargets(deps: Pick<TerminalRouteDeps, "exposure" | "watched">): Promise<string[]> {
  const f = await focusAssets(() => deps.exposure(), () => deps.watched());
  return [...new Set([...f.held, ...f.watched])];
}

export function createIntelRoutes(deps: IntelDeps) {
  const targets = () => intelTargets(deps);
  return new Hono()
    .route("/", createTerminalRoutes(deps))
    .route("/", createAlertsRoutes({ store: deps.store, targets, now: deps.now }))
    .route("/", createGraphRoutes({ store: deps.store, targets, now: deps.now }))
    .route("/", createFlowRoutes(deps))
    .route("/", createResearchRoutes(deps))
    .route("/", createJournalRoutes(deps.journal))
    .route("/", createThesesRoutes(deps.thesis))
    .route("/", createQueryRoutes({ llm: deps.llm, client: deps.queryClient }))
    .route("/", createOrderRoutes(deps.copilot))
    .route("/", createWatchRoutes(deps.docwatch));
}

/** Production deps plus what only the cron jobs need. */
export interface IntelProdDeps extends IntelDeps {
  notifier: Notifier;
  appUrl?: string;
  mapper: MapperDeps;
  ingest: IntelIngestDeps;
  graph: GraphRefreshDeps;
}

let prod: IntelProdDeps | null = null;

/** Production wiring, built once per process (the first caller's env wins). */
export function defaultIntelDeps(env: Record<string, string | undefined> = process.env): IntelProdDeps {
  if (prod) return prod;
  const desk = loadDeskConfig(env);
  const deskService = () => defaultDeskService();
  const terminal = defaultTerminalDeps({
    env,
    watchAddress: desk.watchAddress,
    deskAccount: () => deskService().account(),
    ctxs: async () => (await getCtxs()).ctxs,
  });
  const { store, llm, now } = terminal;
  const notifier = createNotifier(env);
  const targets = () => intelTargets(terminal);
  const mapper: MapperDeps = {
    store,
    llm,
    exposure: terminal.exposure,
    watched: terminal.watched,
    candles1h: terminal.candles1h,
    notifier,
    pushMateriality: terminal.thresholds.pushMateriality,
    appUrl: desk.appUrl,
    now,
  };
  const thesis: ThesisDeps = {
    store,
    llm,
    now,
    observations: (ids) => db.latestObservations(ids),
    ctxs: terminal.ctxs,
    notifier,
  };
  const candles = async (asset: string, from: Date, to: Date) => db.getCandlesBetween(asset, "1h", from, to);
  let journalDeps: JournalDeps | null = null;
  // Built on first journal request: it is the first thing that needs the Desk's store.
  const journal = (): JournalDeps =>
    (journalDeps ??= {
      store,
      llm,
      now,
      tz: env.INTEL_TZ,
      hlFills: desk.watchAddress ? hlFillLoader(desk.watchAddress) : undefined,
      deskFills: deskFillLoader(deskService().store),
      stopFor: journalStopFor(deskService().store, store),
      candles,
      entryState: snapshotEntryState(store, candles),
    });
  prod = {
    ...terminal,
    env,
    // Brief hook (SPEC I0.16, FEATURES §6): every brief run rechecks every thesis.
    onBrief: async () => {
      await recheckAll(thesis);
    },
    journal,
    thesis,
    copilot: () => ({ llm, desk: deskService() }),
    docwatch: { store, llm, now, env, routeAlert: (a) => routeEntities(mapper, a) },
    notifier,
    appUrl: desk.appUrl,
    mapper,
    ingest: { ...mapper, fetch, env, targets, journal },
    graph: { store, llm, targets, now, recordRun: db.recordCollectorRun },
  };
  return prod;
}

/** Telegram /digest + 👍/👎 wiring (SPEC F0.6): the POST /brief builder and the feedback store, for the webhook and the desk worker. */
export function telegramIntel(env: Record<string, string | undefined> = process.env): TelegramIntel {
  const d = defaultIntelDeps(env);
  return { store: d.store, brief: (o) => buildBrief(d, { surface: "ui", ...o }), link: deepLink(d.appUrl) };
}
