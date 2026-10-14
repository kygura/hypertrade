import type {
  Alert,
  AlertKind,
  Brief,
  BriefSurface,
  Cluster,
  Edge,
  EdgeKey,
  EventType,
  FeedbackBucket,
  FlowMetric,
  FlowRow,
  IntelEvent,
  ManualPosition,
  ManualPositionData,
  Report,
  ReportKind,
  Review,
  SnapshotRow,
  Thesis,
  TradeNote,
  Watch,
  WatchChange,
  WatchInput,
  WatchlistItem,
} from "../../shared/intel.js";
import { sql } from "../db.js";
import { iso } from "./util.js";

// Intel persistence (db/migrations/007_intel.sql, 008_intel_stops.sql, 009_flow.sql). Routes, crons and pure
// modules run against IntelStore: MemoryIntelStore in tests, PgIntelStore in
// the app. Both implement the same dedupe and conflict rules; the tests in
// store.test.ts pin them on the memory side.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewEdge = Omit<Edge, "id">;
export type NewEvent = Omit<IntelEvent, "id" | "clusterId"> & { clusterId?: string | null };
export type ClusterInput = Omit<Cluster, "id"> & { id?: string };
export type NewAlert = Omit<Alert, "id" | "createdAt" | "feedback">;
export type NewBrief = Omit<Brief, "id" | "createdAt">;
export type NewReport = DistributiveOmit<Report, "id" | "createdAt">;
export type NewThesis = Omit<Thesis, "id" | "createdAt">;
export type ThesisPatch = Partial<Pick<Thesis, "assets" | "claims" | "invalidation" | "wrongIf" | "checkedAt" | "trace">>;
export type WatchState = Pick<Watch, "lastHash" | "lastSnapshot" | "checkedAt" | "error">;
export type NewWatchChange = Omit<WatchChange, "id" | "ts" | "alertedAssets"> & { ts?: string; alertedAssets?: string[] };
export type SnapshotSide = "nearest" | "before" | "after";
/** A stop-loss trigger seen on the watched HL account at `ts` (db/migrations/008_intel_stops.sql). */
export interface StopRow {
  asset: string;
  side: "long" | "short";
  ts: string;
  stopPx: number;
}

export interface IntelStore {
  listManualPositions(): Promise<ManualPosition[]>;
  getManualPosition(id: string): Promise<ManualPosition | null>;
  createManualPosition(p: ManualPositionData): Promise<ManualPosition>;
  updateManualPosition(id: string, p: ManualPositionData): Promise<ManualPosition | null>;
  deleteManualPosition(id: string): Promise<boolean>;

  getWatchlist(): Promise<WatchlistItem[]>;
  /** Replaces the whole list, keeping the given order. */
  putWatchlist(items: WatchlistItem[]): Promise<void>;

  logReview(r: { via: Review["via"]; briefId?: string | null }): Promise<Review>;
  lastReview(): Promise<Review | null>;
  listReviews(limit: number): Promise<Review[]>;

  /** Upsert on (asset, ts). Returns rows written. */
  insertSnapshots(rows: SnapshotRow[]): Promise<number>;
  /** Closest snapshot to `ts` (ties go to the earlier one), or strictly on one side of it (inclusive). */
  nearestSnapshot(asset: string, ts: Date, side?: SnapshotSide): Promise<SnapshotRow | null>;
  /** from <= ts <= to, ascending. */
  snapshotRange(asset: string, from: Date, to: Date): Promise<SnapshotRow[]>;
  pruneSnapshots(before: Date): Promise<number>;

  /** Upsert on (asset, side, ts). Returns rows written. */
  recordStops(rows: StopRow[]): Promise<number>;
  /** Earliest stop for asset/side with from <= ts (and ts < before, when given), or null. */
  stopAt(asset: string, side: StopRow["side"], from: Date, before?: Date | null): Promise<StopRow | null>;
  pruneStops(before: Date): Promise<number>;

  /** Upsert on (asset, venue, metric, ts). Returns rows written. */
  insertFlow(rows: FlowRow[]): Promise<number>;
  /** ts >= since, one metric or all (null), ascending by ts, then metric, then venue. */
  flowSeries(asset: string, metric: FlowMetric | null, since: Date): Promise<FlowRow[]>;
  /** Newest stored ts (ISO) for the key, or null: the collector's `from`. */
  latestFlowTs(asset: string, venue: string, metric: FlowMetric): Promise<string | null>;
  pruneFlow(before: Date): Promise<number>;

  /** Upsert on (src, dst, type). A user edge is only ever replaced by another user edge. */
  upsertEdges(edges: NewEdge[]): Promise<number>;
  listEdges(): Promise<Edge[]>;
  /** Edges with src or dst in `nodes`. */
  edgesFor(nodes: string[]): Promise<Edge[]>;
  /** Deletes a user edge; seed and LLM edges are left alone (false). */
  deleteUserEdge(key: EdgeKey): Promise<boolean>;

  /** Upsert on `key`: id, firstSeen and an assigned cluster survive re-ingest. Duplicate keys in one call: last wins. */
  upsertEvents(events: NewEvent[]): Promise<IntelEvent[]>;
  getEvent(id: string): Promise<IntelEvent | null>;
  listEvents(opts: { since?: Date; type?: EventType; limit: number }): Promise<IntelEvent[]>;
  eventsByCluster(clusterId: string): Promise<IntelEvent[]>;
  setEventCluster(eventIds: string[], clusterId: string): Promise<void>;
  /** Events with from <= scheduledAt <= to, ascending. */
  listCatalysts(from: Date, to: Date): Promise<IntelEvent[]>;
  /** Deletes a manual event only (false otherwise). */
  deleteManualEvent(id: string): Promise<boolean>;
  upsertCluster(c: ClusterInput): Promise<Cluster>;
  getCluster(id: string): Promise<Cluster | null>;
  listClusters(since: Date): Promise<Cluster[]>;

  /** Null when (kind, ref, asset, window) already exists (SPEC I0.11 / I0.13). */
  insertAlert(a: NewAlert): Promise<Alert | null>;
  /** True when an alert with insertAlert's dedupe key (kind, ref, asset, window) exists. */
  alertExists(k: Pick<NewAlert, "kind" | "ref" | "asset" | "window">): Promise<boolean>;
  getAlert(id: string): Promise<Alert | null>;
  listAlerts(opts: { since?: Date; kind?: AlertKind; route?: Alert["route"]; limit: number }): Promise<Alert[]>;
  setAlertFeedback(id: string, vote: 1 | -1 | null): Promise<Alert | null>;
  /** Votes per (event type, edge type, hops), most downvoted first. */
  feedbackStats(since?: Date): Promise<FeedbackBucket[]>;

  insertBrief(b: NewBrief): Promise<Brief>;
  latestBrief(surface?: BriefSurface): Promise<Brief | null>;

  tradeNotes(tradeIds: string[]): Promise<TradeNote[]>;
  /** Full replace of one trade's note row. */
  putTradeNote(n: Omit<TradeNote, "updatedAt">): Promise<TradeNote>;

  insertReport(r: NewReport): Promise<Report>;
  latestReport<K extends ReportKind>(kind: K): Promise<Extract<Report, { kind: K }> | null>;

  listTheses(): Promise<Thesis[]>;
  getThesis(id: string): Promise<Thesis | null>;
  insertThesis(t: NewThesis): Promise<Thesis>;
  updateThesis(id: string, patch: ThesisPatch): Promise<Thesis | null>;
  deleteThesis(id: string): Promise<boolean>;

  listWatches(): Promise<Watch[]>;
  getWatch(id: string): Promise<Watch | null>;
  insertWatch(w: WatchInput): Promise<Watch>;
  updateWatchState(id: string, s: WatchState): Promise<void>;
  deleteWatch(id: string): Promise<boolean>;
  insertWatchChange(c: NewWatchChange): Promise<WatchChange>;
  /** Records which exposed assets the mapper alerted for a change. */
  setWatchChangeAlerted(id: string, assets: string[]): Promise<void>;
  listWatchChanges(watchId: string, limit: number): Promise<WatchChange[]>;

  getSetting<T>(key: string): Promise<T | null>;
  setSetting(key: string, value: unknown): Promise<void>;

  cacheGet(key: string, promptVersion: string): Promise<unknown | null>;
  cachePut(key: string, promptVersion: string, output: unknown, usage: unknown, model?: string): Promise<void>;
  /** LLM calls recorded (cache rows written) since `since`: the daily cap counter. */
  callsSince(since: Date): Promise<number>;
  /** Stored usage rows (with `model`) since `since`: the dollar caps (F0.7). */
  usageSince(since: Date): Promise<unknown[]>;
}

/** The model rides inside the usage json (no schema change) so spend can be priced. */
const withModel = (usage: unknown, model?: string) => (model && usage && typeof usage === "object" ? { ...usage, model } : usage);

// ---------------------------------------------------------------- shared

const isoOrNull = (d: Date | string | null | undefined) => (d == null ? null : iso(d));
const json = (v: unknown) => sql().json((v ?? null) as any);
const SNAPSHOT_CHUNK = 2000;
/** Ids are uuid columns: anything else would be a Postgres cast error, so it reads as missing (as in the memory store). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (id: string) => UUID.test(id);

/** Duplicate keys in one batch would make Postgres' upsert fail; keep the last of each. */
function lastByKey<T>(items: T[], key: (t: T) => string): T[] {
  return [...new Map(items.map((t) => [key(t), t])).values()];
}

function pickNearest(before: SnapshotRow | null, after: SnapshotRow | null, ts: Date): SnapshotRow | null {
  if (!before || !after) return before ?? after;
  return ts.getTime() - Date.parse(before.ts) <= Date.parse(after.ts) - ts.getTime() ? before : after;
}

/** Most downvoted first, then fewest upvotes; the key breaks ties so both stores order alike. */
function sortBuckets(b: FeedbackBucket[]): FeedbackBucket[] {
  const key = (x: FeedbackBucket) => `${x.eventType ?? ""}|${x.edgeType ?? ""}|${x.hops}`;
  return b.sort((x, y) => y.down - x.down || x.up - y.up || (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

// ---------------------------------------------------------------- postgres

function toPosition(r: any): ManualPosition {
  return {
    id: r.id,
    asset: r.asset,
    side: r.side,
    size: r.size,
    entryPx: r.entry_px,
    stopPx: r.stop_px,
    leverage: r.leverage,
    venue: r.venue,
    createdAt: isoOrNull(r.created_at)!,
    updatedAt: isoOrNull(r.updated_at)!,
  };
}

function toReview(r: any): Review {
  return { id: r.id, ts: isoOrNull(r.ts)!, via: r.via, briefId: r.brief_id };
}

function toSnapshot(r: any): SnapshotRow {
  return {
    asset: r.asset,
    ts: isoOrNull(r.ts)!,
    price: r.price,
    vol24h: r.vol24h,
    funding: r.funding,
    oiUsd: r.oi_usd,
    premium: r.premium,
    basis: r.basis,
    depthBid1: r.depth_bid_1,
    depthAsk1: r.depth_ask_1,
    depthBid2: r.depth_bid_2,
    depthAsk2: r.depth_ask_2,
    spreadBps: r.spread_bps,
  };
}

function toStop(r: any): StopRow {
  return { asset: r.asset, side: r.side, ts: isoOrNull(r.ts)!, stopPx: r.stop_px };
}

function toFlow(r: any): FlowRow {
  return { asset: r.asset, venue: r.venue, metric: r.metric, value: r.value, ts: isoOrNull(r.ts)! };
}

/** flowSeries order, shared by both stores. */
function flowOrder(a: FlowRow, b: FlowRow): number {
  return Date.parse(a.ts) - Date.parse(b.ts) || (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0) || (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0);
}

const flowKey = (r: FlowRow) => `${r.asset}|${r.venue}|${r.metric}|${Date.parse(r.ts)}`;

function toEdge(r: any): Edge {
  return { id: r.id, src: r.src, dst: r.dst, type: r.type, weight: r.weight, source: r.source, lastVerified: isoOrNull(r.last_verified), origin: r.origin };
}

function toEvent(r: any): IntelEvent {
  return {
    id: r.id,
    key: r.key,
    clusterId: r.cluster_id,
    type: r.type,
    title: r.title,
    summary: r.summary,
    entities: r.entities,
    assets: r.assets,
    magnitude: r.magnitude,
    sources: r.sources,
    origin: r.origin,
    firstSeen: isoOrNull(r.first_seen)!,
    scheduledAt: isoOrNull(r.scheduled_at),
    catalyst: r.catalyst,
    tag: r.tag,
    ...(r.flag ? { flag: r.flag } : {}),
  };
}

function toCluster(r: any): Cluster {
  return {
    id: r.id,
    label: r.label,
    entities: r.entities,
    extraction: r.extraction,
    firstSeen: isoOrNull(r.first_seen)!,
    lastSeen: isoOrNull(r.last_seen)!,
    mappedAt: isoOrNull(r.mapped_at),
  };
}

function toAlert(r: any): Alert {
  return {
    id: r.id,
    kind: r.kind,
    ref: r.ref,
    window: r.time_window || null,
    asset: r.asset,
    title: r.title,
    eventType: r.event_type,
    line: r.line,
    path: r.path,
    edgeType: r.edge_type,
    hops: r.hops,
    pathWeight: r.path_weight,
    sources: r.sources,
    materiality: r.materiality,
    pricedIn: r.priced_in,
    route: r.route,
    feedback: r.feedback == null ? null : (Number(r.feedback) as 1 | -1),
    createdAt: isoOrNull(r.created_at)!,
    ...(r.trace ? { trace: r.trace } : {}),
  };
}

function toBrief(r: any): Brief {
  return { id: r.id, createdAt: isoOrNull(r.created_at)!, surface: r.surface, since: isoOrNull(r.since)!, silent: r.silent, ...r.body };
}

function toReport(r: any): Report {
  return { ...r.body, id: r.id, kind: r.kind, createdAt: isoOrNull(r.created_at)! };
}

function toThesis(r: any): Thesis {
  return {
    id: r.id,
    text: r.text,
    assets: r.assets,
    claims: r.claims,
    invalidation: r.invalidation,
    wrongIf: r.wrong_if,
    createdAt: isoOrNull(r.created_at)!,
    checkedAt: isoOrNull(r.checked_at),
    ...(r.trace ? { trace: r.trace } : {}),
  };
}

function toWatch(r: any): Watch {
  return {
    id: r.id,
    kind: r.kind,
    target: r.target,
    chain: r.chain,
    asset: r.asset,
    label: r.label,
    lastHash: r.last_hash,
    lastSnapshot: r.last_snapshot,
    checkedAt: isoOrNull(r.checked_at),
    error: r.error,
    createdAt: isoOrNull(r.created_at)!,
  };
}

function toWatchChange(r: any): WatchChange {
  return {
    id: r.id,
    watchId: r.watch_id,
    ts: isoOrNull(r.ts)!,
    fromHash: r.from_hash,
    toHash: r.to_hash,
    diff: r.diff,
    facts: r.facts,
    detail: r.detail,
    lines: r.lines,
    alertedAssets: r.alerted_assets,
    ...(r.trace ? { trace: r.trace } : {}),
  };
}

function toTradeNote(r: any): TradeNote {
  return { tradeId: r.trade_id, note: r.note, tag: r.tag, summary: r.summary, updatedAt: isoOrNull(r.updated_at)! };
}

export class PgIntelStore implements IntelStore {
  async listManualPositions() {
    const rows = await sql()`select * from intel_positions order by created_at`;
    return rows.map(toPosition);
  }
  async getManualPosition(id: string) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`select * from intel_positions where id = ${id}`;
    return row ? toPosition(row) : null;
  }
  async createManualPosition(p: ManualPositionData) {
    const [row] = await sql()`insert into intel_positions (asset, side, size, entry_px, stop_px, leverage, venue)
      values (${p.asset}, ${p.side}, ${p.size}, ${p.entryPx}, ${p.stopPx ?? null}, ${p.leverage}, ${p.venue}) returning *`;
    return toPosition(row);
  }
  async updateManualPosition(id: string, p: ManualPositionData) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`update intel_positions set asset = ${p.asset}, side = ${p.side}, size = ${p.size}, entry_px = ${p.entryPx},
      stop_px = ${p.stopPx ?? null}, leverage = ${p.leverage}, venue = ${p.venue}, updated_at = now() where id = ${id} returning *`;
    return row ? toPosition(row) : null;
  }
  async deleteManualPosition(id: string) {
    if (!isUuid(id)) return false;
    const res = await sql()`delete from intel_positions where id = ${id}`;
    return res.count > 0;
  }

  async getWatchlist() {
    const rows = await sql()`select asset, tags from intel_watchlist order by ord, asset`;
    return rows.map((r: any) => ({ asset: r.asset, tags: r.tags }));
  }
  async putWatchlist(items: WatchlistItem[]) {
    const rows = items.map((i, ord) => ({ asset: i.asset, tags: json(i.tags), ord }));
    await sql().begin(async (tx) => {
      await tx`delete from intel_watchlist`;
      if (rows.length) await tx`insert into intel_watchlist ${tx(rows, "asset", "tags", "ord")}`;
    });
  }

  async logReview(r: { via: Review["via"]; briefId?: string | null }) {
    const [row] = await sql()`insert into intel_reviews (via, brief_id) values (${r.via}, ${r.briefId ?? null}) returning *`;
    return toReview(row);
  }
  async lastReview() {
    const [row] = await sql()`select * from intel_reviews order by ts desc limit 1`;
    return row ? toReview(row) : null;
  }
  async listReviews(limit: number) {
    const rows = await sql()`select * from intel_reviews order by ts desc limit ${limit}`;
    return rows.map(toReview);
  }

  async insertSnapshots(rows: SnapshotRow[]) {
    let count = 0;
    const all = lastByKey(rows, (r) => `${r.asset}|${Date.parse(r.ts)}`);
    for (let i = 0; i < all.length; i += SNAPSHOT_CHUNK) {
      const values = all.slice(i, i + SNAPSHOT_CHUNK).map((r) => ({
        asset: r.asset, ts: r.ts, price: r.price, vol24h: r.vol24h, funding: r.funding, oi_usd: r.oiUsd, premium: r.premium, basis: r.basis,
        depth_bid_1: r.depthBid1, depth_ask_1: r.depthAsk1, depth_bid_2: r.depthBid2, depth_ask_2: r.depthAsk2, spread_bps: r.spreadBps,
      }));
      const res = await sql()`
        insert into intel_snapshots ${sql()(values, "asset", "ts", "price", "vol24h", "funding", "oi_usd", "premium", "basis", "depth_bid_1", "depth_ask_1", "depth_bid_2", "depth_ask_2", "spread_bps")}
        on conflict (asset, ts) do update set
          price = excluded.price, vol24h = excluded.vol24h, funding = excluded.funding, oi_usd = excluded.oi_usd,
          premium = excluded.premium, basis = excluded.basis, depth_bid_1 = excluded.depth_bid_1, depth_ask_1 = excluded.depth_ask_1,
          depth_bid_2 = excluded.depth_bid_2, depth_ask_2 = excluded.depth_ask_2, spread_bps = excluded.spread_bps
      `;
      count += res.count;
    }
    return count;
  }
  async nearestSnapshot(asset: string, ts: Date, side: SnapshotSide = "nearest") {
    const before = async () => {
      const [r] = await sql()`select * from intel_snapshots where asset = ${asset} and ts <= ${ts} order by ts desc limit 1`;
      return r ? toSnapshot(r) : null;
    };
    const after = async () => {
      const [r] = await sql()`select * from intel_snapshots where asset = ${asset} and ts >= ${ts} order by ts asc limit 1`;
      return r ? toSnapshot(r) : null;
    };
    if (side === "before") return before();
    if (side === "after") return after();
    return pickNearest(await before(), await after(), ts);
  }
  async snapshotRange(asset: string, from: Date, to: Date) {
    const rows = await sql()`select * from intel_snapshots where asset = ${asset} and ts >= ${from} and ts <= ${to} order by ts`;
    return rows.map(toSnapshot);
  }
  async pruneSnapshots(before: Date) {
    const res = await sql()`delete from intel_snapshots where ts < ${before}`;
    return res.count;
  }

  async recordStops(rows: StopRow[]) {
    const values = lastByKey(rows, (r) => `${r.asset}|${r.side}|${Date.parse(r.ts)}`).map((r) => ({ asset: r.asset, side: r.side, ts: r.ts, stop_px: r.stopPx }));
    if (!values.length) return 0;
    const res = await sql()`
      insert into intel_stops ${sql()(values, "asset", "side", "ts", "stop_px")}
      on conflict (asset, side, ts) do update set stop_px = excluded.stop_px
    `;
    return res.count;
  }
  async stopAt(asset: string, side: StopRow["side"], from: Date, before?: Date | null) {
    const [r] = before
      ? await sql()`select * from intel_stops where asset = ${asset} and side = ${side} and ts >= ${from} and ts < ${before} order by ts asc limit 1`
      : await sql()`select * from intel_stops where asset = ${asset} and side = ${side} and ts >= ${from} order by ts asc limit 1`;
    return r ? toStop(r) : null;
  }
  async pruneStops(before: Date) {
    const res = await sql()`delete from intel_stops where ts < ${before}`;
    return res.count;
  }

  async insertFlow(rows: FlowRow[]) {
    let count = 0;
    const all = lastByKey(rows, flowKey);
    for (let i = 0; i < all.length; i += SNAPSHOT_CHUNK) {
      const values = all.slice(i, i + SNAPSHOT_CHUNK).map((r) => ({ asset: r.asset, venue: r.venue, metric: r.metric, value: r.value, ts: r.ts }));
      const res = await sql()`
        insert into intel_flow ${sql()(values, "asset", "venue", "metric", "value", "ts")}
        on conflict (asset, venue, metric, ts) do update set value = excluded.value
      `;
      count += res.count;
    }
    return count;
  }
  async flowSeries(asset: string, metric: FlowMetric | null, since: Date) {
    const rows = metric
      ? await sql()`select * from intel_flow where asset = ${asset} and metric = ${metric} and ts >= ${since} order by ts, metric collate "C", venue collate "C"`
      : await sql()`select * from intel_flow where asset = ${asset} and ts >= ${since} order by ts, metric collate "C", venue collate "C"`;
    return rows.map(toFlow);
  }
  async latestFlowTs(asset: string, venue: string, metric: FlowMetric) {
    const [r] = await sql()`select max(ts) as ts from intel_flow where asset = ${asset} and venue = ${venue} and metric = ${metric}`;
    return isoOrNull(r?.ts);
  }
  async pruneFlow(before: Date) {
    const res = await sql()`delete from intel_flow where ts < ${before}`;
    return res.count;
  }

  async upsertEdges(edges: NewEdge[]) {
    if (!edges.length) return 0;
    const rows = lastByKey(edges, (e) => `${e.src}|${e.dst}|${e.type}`).map((e) => ({
      src: e.src, dst: e.dst, type: e.type, weight: e.weight, source: e.source, last_verified: e.lastVerified, origin: e.origin,
    }));
    const res = await sql()`
      insert into intel_edges ${sql()(rows, "src", "dst", "type", "weight", "source", "last_verified", "origin")}
      on conflict (src, dst, type) do update set
        weight = excluded.weight, source = excluded.source, last_verified = excluded.last_verified, origin = excluded.origin
      where intel_edges.origin <> 'user' or excluded.origin = 'user'
    `;
    return res.count;
  }
  async listEdges() {
    const rows = await sql()`select * from intel_edges order by src, dst, type`;
    return rows.map(toEdge);
  }
  async edgesFor(nodes: string[]) {
    if (!nodes.length) return [];
    const rows = await sql()`select * from intel_edges where src in ${sql()(nodes)} or dst in ${sql()(nodes)} order by src, dst, type`;
    return rows.map(toEdge);
  }
  async deleteUserEdge(k: EdgeKey) {
    const res = await sql()`delete from intel_edges where src = ${k.src} and dst = ${k.dst} and type = ${k.type} and origin = 'user'`;
    return res.count > 0;
  }

  async upsertEvents(events: NewEvent[]) {
    if (!events.length) return [];
    const rows = lastByKey(events, (e) => e.key).map((e) => ({
      key: e.key, cluster_id: e.clusterId ?? null, type: e.type, title: e.title, summary: e.summary,
      entities: json(e.entities), assets: json(e.assets), magnitude: e.magnitude, sources: json(e.sources), origin: e.origin,
      first_seen: e.firstSeen, scheduled_at: e.scheduledAt, catalyst: json(e.catalyst), tag: e.tag, flag: json(e.flag),
    }));
    const out = await sql()`
      insert into intel_events ${sql()(rows, "key", "cluster_id", "type", "title", "summary", "entities", "assets", "magnitude", "sources", "origin", "first_seen", "scheduled_at", "catalyst", "tag", "flag")}
      on conflict (key) do update set
        cluster_id = coalesce(excluded.cluster_id, intel_events.cluster_id), type = excluded.type, title = excluded.title,
        summary = excluded.summary, entities = excluded.entities, assets = excluded.assets, magnitude = excluded.magnitude,
        sources = excluded.sources, origin = excluded.origin, scheduled_at = excluded.scheduled_at, catalyst = excluded.catalyst, tag = excluded.tag,
        flag = excluded.flag
      returning *
    `;
    return out.map(toEvent);
  }
  async getEvent(id: string) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`select * from intel_events where id = ${id}`;
    return row ? toEvent(row) : null;
  }
  async listEvents(opts: { since?: Date; type?: EventType; limit: number }) {
    const since = opts.since ?? null;
    const type = opts.type ?? null;
    const rows = await sql()`select * from intel_events
      where (${since}::timestamptz is null or first_seen >= ${since}) and (${type}::text is null or type = ${type})
      order by first_seen desc limit ${opts.limit}`;
    return rows.map(toEvent);
  }
  async eventsByCluster(clusterId: string) {
    if (!isUuid(clusterId)) return [];
    const rows = await sql()`select * from intel_events where cluster_id = ${clusterId} order by first_seen`;
    return rows.map(toEvent);
  }
  async setEventCluster(eventIds: string[], clusterId: string) {
    const ids = eventIds.filter(isUuid);
    if (!ids.length || !isUuid(clusterId)) return;
    await sql()`update intel_events set cluster_id = ${clusterId} where id in ${sql()(ids)}`;
  }
  async listCatalysts(from: Date, to: Date) {
    const rows = await sql()`select * from intel_events where scheduled_at >= ${from} and scheduled_at <= ${to} order by scheduled_at`;
    return rows.map(toEvent);
  }
  async deleteManualEvent(id: string) {
    if (!isUuid(id)) return false;
    const res = await sql()`delete from intel_events where id = ${id} and origin = 'manual'`;
    return res.count > 0;
  }
  async upsertCluster(c: ClusterInput) {
    const [row] = await sql()`insert into intel_clusters (id, label, entities, extraction, first_seen, last_seen, mapped_at)
      values (${c.id ?? crypto.randomUUID()}, ${c.label}, ${json(c.entities)}, ${json(c.extraction)}, ${c.firstSeen}, ${c.lastSeen}, ${c.mappedAt})
      on conflict (id) do update set label = excluded.label, entities = excluded.entities, extraction = excluded.extraction,
        first_seen = excluded.first_seen, last_seen = excluded.last_seen, mapped_at = excluded.mapped_at
      returning *`;
    return toCluster(row);
  }
  async getCluster(id: string) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`select * from intel_clusters where id = ${id}`;
    return row ? toCluster(row) : null;
  }
  async listClusters(since: Date) {
    const rows = await sql()`select * from intel_clusters where last_seen >= ${since} order by last_seen desc`;
    return rows.map(toCluster);
  }

  async insertAlert(a: NewAlert) {
    const [row] = await sql()`insert into intel_alerts
      (kind, ref, time_window, asset, title, event_type, line, path, edge_type, hops, path_weight, sources, materiality, priced_in, route, trace)
      values (${a.kind}, ${a.ref}, ${a.window ?? ""}, ${a.asset}, ${a.title}, ${a.eventType}, ${json(a.line)}, ${json(a.path)},
        ${a.edgeType}, ${a.hops}, ${a.pathWeight}, ${json(a.sources)}, ${a.materiality}, ${json(a.pricedIn)}, ${a.route}, ${json(a.trace)})
      on conflict (kind, ref, asset, time_window) do nothing
      returning *`;
    return row ? toAlert(row) : null;
  }
  async alertExists(k: Pick<NewAlert, "kind" | "ref" | "asset" | "window">) {
    const [row] = await sql()`select 1 from intel_alerts
      where kind = ${k.kind} and ref = ${k.ref} and asset = ${k.asset} and time_window = ${k.window ?? ""} limit 1`;
    return !!row;
  }
  async getAlert(id: string) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`select * from intel_alerts where id = ${id}`;
    return row ? toAlert(row) : null;
  }
  async listAlerts(opts: { since?: Date; kind?: AlertKind; route?: Alert["route"]; limit: number }) {
    const since = opts.since ?? null;
    const kind = opts.kind ?? null;
    const route = opts.route ?? null;
    const rows = await sql()`select * from intel_alerts
      where (${since}::timestamptz is null or created_at >= ${since}) and (${kind}::text is null or kind = ${kind})
        and (${route}::text is null or route = ${route})
      order by created_at desc limit ${opts.limit}`;
    return rows.map(toAlert);
  }
  async setAlertFeedback(id: string, vote: 1 | -1 | null) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`update intel_alerts set feedback = ${vote} where id = ${id} returning *`;
    return row ? toAlert(row) : null;
  }
  async feedbackStats(since?: Date) {
    const lo = since ?? null;
    const rows = await sql()`select event_type, edge_type, hops,
        (count(*) filter (where feedback = 1))::int as up, (count(*) filter (where feedback = -1))::int as down, count(*)::int as total
      from intel_alerts where (${lo}::timestamptz is null or created_at >= ${lo})
      group by event_type, edge_type, hops`;
    return sortBuckets(rows.map((r: any) => ({ eventType: r.event_type, edgeType: r.edge_type, hops: r.hops, up: r.up, down: r.down, total: r.total })));
  }

  async insertBrief(b: NewBrief) {
    const { surface, since, silent, ...body } = b;
    const [row] = await sql()`insert into intel_briefs (surface, since, silent, body)
      values (${surface}, ${since}, ${silent}, ${json(body)}) returning *`;
    return toBrief(row);
  }
  async latestBrief(surface?: BriefSurface) {
    const s = surface ?? null;
    const [row] = await sql()`select * from intel_briefs where (${s}::text is null or surface = ${s}) order by created_at desc limit 1`;
    return row ? toBrief(row) : null;
  }

  async tradeNotes(tradeIds: string[]) {
    if (!tradeIds.length) return [];
    const rows = await sql()`select * from intel_trade_notes where trade_id in ${sql()(tradeIds)}`;
    return rows.map(toTradeNote);
  }
  async putTradeNote(n: Omit<TradeNote, "updatedAt">) {
    const [row] = await sql()`insert into intel_trade_notes (trade_id, note, tag, summary, updated_at)
      values (${n.tradeId}, ${n.note}, ${n.tag}, ${json(n.summary)}, now())
      on conflict (trade_id) do update set note = excluded.note, tag = excluded.tag, summary = excluded.summary, updated_at = now()
      returning *`;
    return toTradeNote(row);
  }

  async insertReport(r: NewReport) {
    const { kind, ...body } = r;
    const [row] = await sql()`insert into intel_reports (kind, body) values (${kind}, ${json(body)}) returning *`;
    return toReport(row);
  }
  async latestReport<K extends ReportKind>(kind: K) {
    const [row] = await sql()`select * from intel_reports where kind = ${kind} order by created_at desc limit 1`;
    return row ? (toReport(row) as Extract<Report, { kind: K }>) : null;
  }

  async listTheses() {
    const rows = await sql()`select * from intel_theses order by created_at desc`;
    return rows.map(toThesis);
  }
  async getThesis(id: string) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`select * from intel_theses where id = ${id}`;
    return row ? toThesis(row) : null;
  }
  async insertThesis(t: NewThesis) {
    const [row] = await sql()`insert into intel_theses (text, assets, claims, invalidation, wrong_if, trace, checked_at)
      values (${t.text}, ${json(t.assets)}, ${json(t.claims)}, ${json(t.invalidation)}, ${json(t.wrongIf)}, ${json(t.trace)}, ${t.checkedAt})
      returning *`;
    return toThesis(row);
  }
  async updateThesis(id: string, patch: ThesisPatch) {
    const cur = await this.getThesis(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    const [row] = await sql()`update intel_theses set assets = ${json(n.assets)}, claims = ${json(n.claims)}, invalidation = ${json(n.invalidation)},
      wrong_if = ${json(n.wrongIf)}, trace = ${json(n.trace)}, checked_at = ${n.checkedAt} where id = ${id} returning *`;
    return row ? toThesis(row) : null;
  }
  async deleteThesis(id: string) {
    if (!isUuid(id)) return false;
    const res = await sql()`delete from intel_theses where id = ${id}`;
    return res.count > 0;
  }

  async listWatches() {
    const rows = await sql()`select * from intel_watches order by created_at`;
    return rows.map(toWatch);
  }
  async getWatch(id: string) {
    if (!isUuid(id)) return null;
    const [row] = await sql()`select * from intel_watches where id = ${id}`;
    return row ? toWatch(row) : null;
  }
  async insertWatch(w: WatchInput) {
    const chain = w.kind === "url" ? null : w.chain;
    const [row] = await sql()`insert into intel_watches (kind, target, chain, asset, label)
      values (${w.kind}, ${w.target}, ${chain}, ${w.asset ?? null}, ${w.label}) returning *`;
    return toWatch(row);
  }
  async updateWatchState(id: string, s: WatchState) {
    if (!isUuid(id)) return;
    await sql()`update intel_watches set last_hash = ${s.lastHash}, last_snapshot = ${json(s.lastSnapshot)}, checked_at = ${s.checkedAt},
      error = ${s.error} where id = ${id}`;
  }
  async deleteWatch(id: string) {
    if (!isUuid(id)) return false;
    const res = await sql()`delete from intel_watches where id = ${id}`;
    return res.count > 0;
  }
  async insertWatchChange(c: NewWatchChange) {
    const [row] = await sql()`insert into intel_watch_changes (watch_id, ts, from_hash, to_hash, diff, facts, detail, lines, alerted_assets, trace)
      values (${c.watchId}, ${c.ts ?? new Date().toISOString()}, ${c.fromHash}, ${c.toHash}, ${c.diff}, ${json(c.facts)}, ${json(c.detail)},
        ${json(c.lines)}, ${json(c.alertedAssets ?? [])}, ${json(c.trace)})
      returning *`;
    return toWatchChange(row);
  }
  async setWatchChangeAlerted(id: string, assets: string[]) {
    if (!isUuid(id)) return;
    await sql()`update intel_watch_changes set alerted_assets = ${json(assets)} where id = ${id}`;
  }
  async listWatchChanges(watchId: string, limit: number) {
    if (!isUuid(watchId)) return [];
    const rows = await sql()`select * from intel_watch_changes where watch_id = ${watchId} order by ts desc limit ${limit}`;
    return rows.map(toWatchChange);
  }

  async getSetting<T>(key: string) {
    const [row] = await sql()`select value from intel_settings where key = ${key}`;
    return row ? (row.value as T) : null;
  }
  async setSetting(key: string, value: unknown) {
    await sql()`insert into intel_settings (key, value, updated_at) values (${key}, ${json(value)}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }

  async cacheGet(key: string, promptVersion: string) {
    const [row] = await sql()`select output from intel_llm_cache where key = ${key} and prompt_version = ${promptVersion}`;
    return row ? (row.output as unknown) : null;
  }
  async cachePut(key: string, promptVersion: string, output: unknown, usage: unknown, model?: string) {
    await sql()`insert into intel_llm_cache (key, prompt_version, output, usage) values (${key}, ${promptVersion}, ${json(output)}, ${json(withModel(usage, model))})
      on conflict (key, prompt_version) do update set output = excluded.output, usage = excluded.usage, created_at = now()`;
  }
  async callsSince(since: Date) {
    const [row] = await sql()`select count(*)::int as n from intel_llm_cache where created_at >= ${since}`;
    return row!.n as number;
  }
  async usageSince(since: Date) {
    return (await sql()`select usage from intel_llm_cache where created_at >= ${since}`).map((r) => r.usage as unknown);
  }
}

// ---------------------------------------------------------------- memory

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** In-process store for tests and local runs without a database. */
const alertKey = (x: { kind: string; ref: string; asset: string; window?: string | null }) => `${x.kind}|${x.ref}|${x.asset}|${x.window ?? ""}`;

export class MemoryIntelStore implements IntelStore {
  positions = new Map<string, ManualPosition>();
  watchlist: WatchlistItem[] = [];
  reviews: Review[] = [];
  snapshots = new Map<string, SnapshotRow>();
  stops = new Map<string, StopRow>();
  flow = new Map<string, FlowRow>();
  edges = new Map<string, Edge>();
  events = new Map<string, IntelEvent>();
  clusters = new Map<string, Cluster>();
  alerts: Alert[] = [];
  briefs: Brief[] = [];
  notes = new Map<string, TradeNote>();
  reports: Report[] = [];
  theses = new Map<string, Thesis>();
  watches = new Map<string, Watch>();
  changes: WatchChange[] = [];
  settings = new Map<string, unknown>();
  cache = new Map<string, { output: unknown; usage: unknown; createdAt: number }>();
  private n = 0;
  constructor(private readonly clock: () => Date = () => new Date()) {}
  private id() {
    this.n++;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }
  private now() {
    return this.clock().toISOString();
  }

  async listManualPositions() {
    return [...this.positions.values()].map(clone);
  }
  async getManualPosition(id: string) {
    return clone(this.positions.get(id) ?? null);
  }
  async createManualPosition(p: ManualPositionData) {
    const now = this.now();
    const row: ManualPosition = { id: this.id(), ...p, stopPx: p.stopPx ?? null, createdAt: now, updatedAt: now };
    this.positions.set(row.id, row);
    return clone(row);
  }
  async updateManualPosition(id: string, p: ManualPositionData) {
    const cur = this.positions.get(id);
    if (!cur) return null;
    const row: ManualPosition = { ...cur, ...p, stopPx: p.stopPx ?? null, updatedAt: this.now() };
    this.positions.set(id, row);
    return clone(row);
  }
  async deleteManualPosition(id: string) {
    return this.positions.delete(id);
  }

  async getWatchlist() {
    return clone(this.watchlist);
  }
  async putWatchlist(items: WatchlistItem[]) {
    this.watchlist = clone(items);
  }

  async logReview(r: { via: Review["via"]; briefId?: string | null }) {
    const row: Review = { id: this.id(), ts: this.now(), via: r.via, briefId: r.briefId ?? null };
    this.reviews.push(row);
    return clone(row);
  }
  async lastReview() {
    return clone(this.reviews.at(-1) ?? null);
  }
  async listReviews(limit: number) {
    return clone([...this.reviews].reverse().slice(0, limit));
  }

  private assetSnapshots(asset: string) {
    return [...this.snapshots.values()].filter((s) => s.asset === asset).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  async insertSnapshots(rows: SnapshotRow[]) {
    const all = lastByKey(rows, (r) => `${r.asset}|${Date.parse(r.ts)}`);
    for (const r of all) this.snapshots.set(`${r.asset}|${Date.parse(r.ts)}`, { ...r, ts: isoOrNull(r.ts)! });
    return all.length;
  }
  async nearestSnapshot(asset: string, ts: Date, side: SnapshotSide = "nearest") {
    const rows = this.assetSnapshots(asset);
    const t = ts.getTime();
    const before = rows.filter((r) => Date.parse(r.ts) <= t).at(-1) ?? null;
    const after = rows.find((r) => Date.parse(r.ts) >= t) ?? null;
    const pick = side === "before" ? before : side === "after" ? after : pickNearest(before, after, ts);
    return clone(pick);
  }
  async snapshotRange(asset: string, from: Date, to: Date) {
    return this.assetSnapshots(asset).filter((r) => Date.parse(r.ts) >= from.getTime() && Date.parse(r.ts) <= to.getTime()).map(clone);
  }
  async pruneSnapshots(before: Date) {
    let n = 0;
    for (const [k, s] of this.snapshots) if (Date.parse(s.ts) < before.getTime()) (this.snapshots.delete(k), n++);
    return n;
  }

  async recordStops(rows: StopRow[]) {
    const all = lastByKey(rows, (r) => `${r.asset}|${r.side}|${Date.parse(r.ts)}`);
    for (const r of all) this.stops.set(`${r.asset}|${r.side}|${Date.parse(r.ts)}`, { ...r, ts: isoOrNull(r.ts)! });
    return all.length;
  }
  async stopAt(asset: string, side: StopRow["side"], from: Date, before?: Date | null) {
    const hit = [...this.stops.values()]
      .filter((s) => s.asset === asset && s.side === side && Date.parse(s.ts) >= from.getTime() && (!before || Date.parse(s.ts) < before.getTime()))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
    return clone(hit ?? null);
  }
  async pruneStops(before: Date) {
    let n = 0;
    for (const [k, s] of this.stops) if (Date.parse(s.ts) < before.getTime()) (this.stops.delete(k), n++);
    return n;
  }

  async insertFlow(rows: FlowRow[]) {
    const all = lastByKey(rows, flowKey);
    for (const r of all) this.flow.set(flowKey(r), { ...r, ts: isoOrNull(r.ts)! });
    return all.length;
  }
  async flowSeries(asset: string, metric: FlowMetric | null, since: Date) {
    return [...this.flow.values()]
      .filter((r) => r.asset === asset && (!metric || r.metric === metric) && Date.parse(r.ts) >= since.getTime())
      .sort(flowOrder)
      .map(clone);
  }
  async latestFlowTs(asset: string, venue: string, metric: FlowMetric) {
    let best: string | null = null;
    for (const r of this.flow.values()) if (r.asset === asset && r.venue === venue && r.metric === metric && (!best || r.ts > best)) best = r.ts;
    return best;
  }
  async pruneFlow(before: Date) {
    let n = 0;
    for (const [k, r] of this.flow) if (Date.parse(r.ts) < before.getTime()) (this.flow.delete(k), n++);
    return n;
  }

  async upsertEdges(edges: NewEdge[]) {
    let n = 0;
    for (const e of lastByKey(edges, (e) => `${e.src}|${e.dst}|${e.type}`)) {
      const k = `${e.src}|${e.dst}|${e.type}`;
      const cur = this.edges.get(k);
      if (cur && cur.origin === "user" && e.origin !== "user") continue;
      this.edges.set(k, { ...clone(e), lastVerified: isoOrNull(e.lastVerified), id: cur?.id ?? this.id() });
      n++;
    }
    return n;
  }
  async listEdges() {
    return [...this.edges.values()].sort((a, b) => `${a.src}|${a.dst}|${a.type}`.localeCompare(`${b.src}|${b.dst}|${b.type}`)).map(clone);
  }
  async edgesFor(nodes: string[]) {
    const set = new Set(nodes);
    return (await this.listEdges()).filter((e) => set.has(e.src) || set.has(e.dst));
  }
  async deleteUserEdge(k: EdgeKey) {
    const key = `${k.src}|${k.dst}|${k.type}`;
    return this.edges.get(key)?.origin === "user" ? this.edges.delete(key) : false;
  }

  async upsertEvents(events: NewEvent[]) {
    const out: IntelEvent[] = [];
    for (const e of lastByKey(events, (e) => e.key)) {
      const cur = [...this.events.values()].find((x) => x.key === e.key);
      const row: IntelEvent = {
        ...clone(e),
        id: cur?.id ?? this.id(),
        clusterId: e.clusterId ?? cur?.clusterId ?? null,
        firstSeen: cur?.firstSeen ?? isoOrNull(e.firstSeen)!,
        scheduledAt: isoOrNull(e.scheduledAt),
      };
      this.events.set(row.id, row);
      out.push(clone(row));
    }
    return out;
  }
  async getEvent(id: string) {
    return clone(this.events.get(id) ?? null);
  }
  async listEvents(opts: { since?: Date; type?: EventType; limit: number }) {
    return [...this.events.values()]
      .filter((e) => (!opts.since || Date.parse(e.firstSeen) >= opts.since.getTime()) && (!opts.type || e.type === opts.type))
      .sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen))
      .slice(0, opts.limit)
      .map(clone);
  }
  async eventsByCluster(clusterId: string) {
    return [...this.events.values()]
      .filter((e) => e.clusterId === clusterId)
      .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen))
      .map(clone);
  }
  async setEventCluster(eventIds: string[], clusterId: string) {
    for (const id of eventIds) {
      const e = this.events.get(id);
      if (e) e.clusterId = clusterId;
    }
  }
  async listCatalysts(from: Date, to: Date) {
    return [...this.events.values()]
      .filter((e) => e.scheduledAt && Date.parse(e.scheduledAt) >= from.getTime() && Date.parse(e.scheduledAt) <= to.getTime())
      .sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!))
      .map(clone);
  }
  async deleteManualEvent(id: string) {
    return this.events.get(id)?.origin === "manual" ? this.events.delete(id) : false;
  }
  async upsertCluster(c: ClusterInput) {
    const row: Cluster = { ...clone(c), id: c.id ?? crypto.randomUUID(), firstSeen: iso(c.firstSeen), lastSeen: iso(c.lastSeen), mappedAt: isoOrNull(c.mappedAt) };
    this.clusters.set(row.id, row);
    return clone(row);
  }
  async getCluster(id: string) {
    return clone(this.clusters.get(id) ?? null);
  }
  async listClusters(since: Date) {
    return [...this.clusters.values()]
      .filter((c) => Date.parse(c.lastSeen) >= since.getTime())
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      .map(clone);
  }

  async alertExists(k: Pick<NewAlert, "kind" | "ref" | "asset" | "window">) {
    return this.alerts.some((x) => alertKey(x) === alertKey(k));
  }
  async insertAlert(a: NewAlert) {
    if (await this.alertExists(a)) return null;
    const row: Alert = { ...clone(a), id: this.id(), feedback: null, createdAt: this.now() };
    if (row.trace === undefined) delete row.trace;
    this.alerts.push(row);
    return clone(row);
  }
  async getAlert(id: string) {
    return clone(this.alerts.find((a) => a.id === id) ?? null);
  }
  async listAlerts(opts: { since?: Date; kind?: AlertKind; route?: Alert["route"]; limit: number }) {
    return [...this.alerts]
      .reverse()
      .filter((a) => (!opts.since || Date.parse(a.createdAt) >= opts.since.getTime()) && (!opts.kind || a.kind === opts.kind) && (!opts.route || a.route === opts.route))
      .slice(0, opts.limit)
      .map(clone);
  }
  async setAlertFeedback(id: string, vote: 1 | -1 | null) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return null;
    a.feedback = vote;
    return clone(a);
  }
  async feedbackStats(since?: Date) {
    const buckets = new Map<string, FeedbackBucket>();
    for (const a of this.alerts) {
      if (since && Date.parse(a.createdAt) < since.getTime()) continue;
      const k = JSON.stringify([a.eventType, a.edgeType, a.hops]);
      const b = buckets.get(k) ?? { eventType: a.eventType, edgeType: a.edgeType, hops: a.hops, up: 0, down: 0, total: 0 };
      b.total++;
      if (a.feedback === 1) b.up++;
      if (a.feedback === -1) b.down++;
      buckets.set(k, b);
    }
    return sortBuckets([...buckets.values()]);
  }

  async insertBrief(b: NewBrief) {
    const row: Brief = { ...clone(b), since: iso(b.since), id: this.id(), createdAt: this.now() };
    this.briefs.push(row);
    return clone(row);
  }
  async latestBrief(surface?: BriefSurface) {
    return clone([...this.briefs].reverse().find((b) => !surface || b.surface === surface) ?? null);
  }

  async tradeNotes(tradeIds: string[]) {
    return tradeIds.flatMap((id) => (this.notes.has(id) ? [clone(this.notes.get(id)!)] : []));
  }
  async putTradeNote(n: Omit<TradeNote, "updatedAt">) {
    const row: TradeNote = { ...n, updatedAt: this.now() };
    this.notes.set(n.tradeId, row);
    return clone(row);
  }

  async insertReport(r: NewReport) {
    const row = { ...clone(r), id: this.id(), createdAt: this.now() } as Report;
    this.reports.push(row);
    return clone(row);
  }
  async latestReport<K extends ReportKind>(kind: K) {
    const r = [...this.reports].reverse().find((x) => x.kind === kind);
    return r ? (clone(r) as Extract<Report, { kind: K }>) : null;
  }

  async listTheses() {
    return [...this.theses.values()].reverse().map(clone);
  }
  async getThesis(id: string) {
    return clone(this.theses.get(id) ?? null);
  }
  async insertThesis(t: NewThesis) {
    const row: Thesis = { ...clone(t), checkedAt: isoOrNull(t.checkedAt), id: this.id(), createdAt: this.now() };
    this.theses.set(row.id, row);
    return clone(row);
  }
  async updateThesis(id: string, patch: ThesisPatch) {
    const cur = this.theses.get(id);
    if (!cur) return null;
    const row = { ...cur, ...clone(patch) };
    row.checkedAt = isoOrNull(row.checkedAt);
    this.theses.set(id, row);
    return clone(row);
  }
  async deleteThesis(id: string) {
    return this.theses.delete(id);
  }

  async listWatches() {
    return [...this.watches.values()].map(clone);
  }
  async getWatch(id: string) {
    return clone(this.watches.get(id) ?? null);
  }
  async insertWatch(w: WatchInput) {
    const row: Watch = {
      id: this.id(),
      kind: w.kind,
      target: w.target,
      chain: w.kind === "url" ? null : w.chain,
      asset: w.asset ?? null,
      label: w.label,
      lastHash: null,
      lastSnapshot: null,
      checkedAt: null,
      error: null,
      createdAt: this.now(),
    };
    this.watches.set(row.id, row);
    return clone(row);
  }
  async updateWatchState(id: string, s: WatchState) {
    const w = this.watches.get(id);
    if (w) Object.assign(w, clone(s), { checkedAt: isoOrNull(s.checkedAt) });
  }
  async deleteWatch(id: string) {
    this.changes = this.changes.filter((c) => c.watchId !== id);
    return this.watches.delete(id);
  }
  async insertWatchChange(c: NewWatchChange) {
    if (!this.watches.has(c.watchId)) throw new Error(`watch ${c.watchId} not found`);
    const row: WatchChange = { ...clone(c), id: this.id(), ts: isoOrNull(c.ts) ?? this.now(), alertedAssets: clone(c.alertedAssets) ?? [] };
    this.changes.push(row);
    return clone(row);
  }
  async setWatchChangeAlerted(id: string, assets: string[]) {
    const c = this.changes.find((x) => x.id === id);
    if (c) c.alertedAssets = [...assets];
  }
  async listWatchChanges(watchId: string, limit: number) {
    return this.changes
      .filter((c) => c.watchId === watchId)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, limit)
      .map(clone);
  }

  async getSetting<T>(key: string) {
    return (this.settings.has(key) ? clone(this.settings.get(key)) : null) as T | null;
  }
  async setSetting(key: string, value: unknown) {
    this.settings.set(key, clone(value));
  }

  async cacheGet(key: string, promptVersion: string) {
    const hit = this.cache.get(JSON.stringify([key, promptVersion]));
    return hit ? clone(hit.output) : null;
  }
  async cachePut(key: string, promptVersion: string, output: unknown, usage: unknown, model?: string) {
    this.cache.set(JSON.stringify([key, promptVersion]), { output: clone(output), usage: clone(withModel(usage, model)), createdAt: this.clock().getTime() });
  }
  async callsSince(since: Date) {
    return [...this.cache.values()].filter((c) => c.createdAt >= since.getTime()).length;
  }
  async usageSince(since: Date) {
    return [...this.cache.values()].filter((c) => c.createdAt >= since.getTime()).map((c) => clone(c.usage));
  }
}
