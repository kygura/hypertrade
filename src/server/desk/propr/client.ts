// Propr REST client (docs: propr.xyz/developers, propr.xyz/openapi.json), ported from perp-radar's executor.
// The key comes only from PROPR_API_KEY. It is held in a private field, sent only in the X-API-Key header to
// Propr's own hosts, and scrubbed from every error message. Every answer is parsed with zod (schemas.ts): a shape the
// desk does not know throws, it never reads as an empty list. Rows are parsed one by one: a row that cannot be read
// and cannot be live is dropped; one that may be live throws, unless the caller passes a `skipped` list (the reads
// behind exits, the kill switch and housekeeping), which then names it and the rest of the list is returned.

import type { z } from "zod";
import { AccountSchema, AttemptRowSchema, ListSchema, MarginConfigSchema, OrderRowSchema, PositionRowSchema, RowSchema, TradeRowSchema, orderIsOver, positionIsFlat, type Row } from "./schemas.js";

export type { Row };

const HOSTS = new Set(["api.propr.xyz", "api.beta.propr.xyz"]);
const PROPR_LIVE_URL = "https://api.propr.xyz/v1";
const TIMEOUT_MS = 15_000;

class ProprError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** Drop anything that looks like a Propr key from text that may end up in a log, an alert or a record. */
export const scrub = (s: string) => s.replace(/pk_(live|test)_[A-Za-z0-9_\-]+/g, "pk_***");

/** Only Propr's own hosts, over https, so a bad PROPR_API_URL can never send the key elsewhere. */
export function proprBaseUrl(raw: string | undefined): string {
  const v = raw?.trim() || PROPR_LIVE_URL;
  const u = new URL(v);
  if (u.protocol !== "https:" || !HOSTS.has(u.host)) throw new Error("PROPR_API_URL must be https://api.propr.xyz/v1 or https://api.beta.propr.xyz/v1");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export type ProprOrderRequest = {
  accountId: string;
  intentId: string;
  exchange: "hyperliquid";
  type: "market" | "limit" | "stop_market" | "take_profit_market";
  side: "buy" | "sell";
  positionSide: "long" | "short";
  productType: "perp";
  timeInForce: "IOC" | "GTC";
  asset: string;
  base: string;
  quote: "USDC";
  quantity: string;
  price?: string;
  triggerPrice?: string;
  reduceOnly: boolean;
  closePosition: boolean;
};

const unknownShape = (what: string, e: z.ZodError) => {
  const i = e.issues[0];
  return scrub(`${what}: answer not in a shape the desk knows (${i ? `${i.path.join(".") || "body"}: ${i.message}` : "invalid"})`);
};
/** Parses an answer, or throws naming the request and the first thing that did not fit. */
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new ProprError(200, null, unknownShape(what, r.error));
}
/** How a list's rows are read: `over` says an unreadable row cannot matter (dropped); `skipped` collects the others instead of throwing. */
interface RowRead {
  over?: (r: Row) => boolean;
  skipped?: string[];
}
/** The rows of a list answer and the total it reports. The envelope must be a list; each row is parsed on its own. */
function list<S extends z.ZodTypeAny>(body: unknown, row: S, what: string, read: RowRead = {}): { rows: Array<z.infer<S>>; total: number | null } {
  const b = parse(ListSchema, body, what);
  const raw = Array.isArray(b) ? b : b.data;
  const rows: Array<z.infer<S>> = [];
  for (const [i, r] of raw.entries()) {
    const p = row.safeParse(r);
    if (p.success) rows.push(p.data);
    else if (read.over?.(r)) continue;
    else if (read.skipped) read.skipped.push(unknownShape(`${what} row ${i}`, p.error));
    else throw new ProprError(200, null, unknownShape(`${what} row ${i}`, p.error));
  }
  const t = Array.isArray(b) ? null : typeof b.total === "string" && b.total.trim() !== "" ? Number(b.total) : b.total;
  return { rows, total: typeof t === "number" && Number.isFinite(t) ? t : null };
}
const PAGE = 100;
const MAX_PAGES = 10;
/** Challenge attempts that can trade: active challenges and passed (funded) ones. */
const TRADABLE = new Set(["active", "passed", "funded"]);

export class ProprClient {
  readonly #key: string;
  readonly base: string;
  constructor(
    key: string,
    base: string = PROPR_LIVE_URL,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    if (!key) throw new Error("PROPR_API_KEY is not set");
    this.#key = key;
    this.base = proprBaseUrl(base);
  }

  private async req(method: "GET" | "POST" | "PUT", path: string, opts: { params?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {}): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth !== false) headers["x-api-key"] = this.#key;
    let r: Response;
    try {
      // redirect "error": a redirect would resend the key to wherever it points.
      r = await this.fetchFn(url, { method, headers, redirect: "error", body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new ProprError(0, null, scrub(`${method} ${path}: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (!r.ok) {
      let code: number | null = null;
      let msg = r.statusText;
      try {
        const b = (await r.json()) as { code?: number; message?: string };
        code = b.code ?? null;
        msg = b.message ?? msg;
      } catch {}
      throw new ProprError(r.status, code, scrub(`${method} ${path}: ${r.status}${code ? ` ${code}` : ""} ${msg}`));
    }
    try {
      return await r.json();
    } catch {
      throw new ProprError(r.status, null, `${method} ${path}: answer is not JSON`);
    }
  }

  /**
   * Every page of a list (limit/offset, Propr's default page is 20): until a short page, the reported total, or
   * `until` says the rest is older than needed (lists come newest first). At most ten pages of a hundred.
   */
  private async all<S extends z.ZodTypeAny>(path: string, row: S, read: RowRead = {}, params: Record<string, string | number | undefined> = {}, until?: (r: z.infer<S>) => boolean): Promise<Array<z.infer<S>>> {
    const out: Array<z.infer<S>> = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      // Paging counts the rows Propr sent, dropped and skipped ones included.
      const body = await this.req("GET", path, { params: { ...params, limit: PAGE, offset: page * PAGE } });
      const sent = Array.isArray(body) ? body.length : Array.isArray((body as { data?: unknown } | null)?.data) ? (body as { data: unknown[] }).data.length : 0;
      const { rows: got, total } = list(body, row, `GET ${path}`, read);
      out.push(...got);
      if (sent < PAGE || (total != null && (page + 1) * PAGE >= total) || (until && got.length && until(got[got.length - 1]!))) break;
    }
    return out;
  }

  /** Challenge attempts that can trade (active, or passed and funded). */
  async attempts(skipped?: string[]): Promise<Row[]> {
    return (await this.all("/challenge-attempts", AttemptRowSchema, { skipped })).filter((a) => TRADABLE.has(String(a.status)));
  }
  /** Balance, margin balance, unrealized P&L (the SDK's get_account). */
  async account(accountId: string): Promise<Row> {
    const path = `/accounts/${encodeURIComponent(accountId)}`;
    return parse(AccountSchema, await this.req("GET", path), `GET ${path}`);
  }
  /** Open positions. A row that cannot be read and is not flat throws, or goes to `skipped` when given. */
  positions(accountId: string, skipped?: string[]): Promise<Row[]> {
    return this.all(`/accounts/${encodeURIComponent(accountId)}/positions`, PositionRowSchema, { over: positionIsFlat, skipped }, { status: "open" });
  }
  /** Every order (open ones can be days old: a held position's stop), up to a thousand. A row that cannot be read and is not over throws, or goes to `skipped` when given. */
  orders(accountId: string, skipped?: string[]): Promise<Row[]> {
    return this.all(`/accounts/${encodeURIComponent(accountId)}/orders`, OrderRowSchema, { over: orderIsOver, skipped });
  }
  /** Trades back to `since` (the day's realized P&L). */
  trades(accountId: string, since: number, skipped?: string[]): Promise<Row[]> {
    return this.all(`/accounts/${encodeURIComponent(accountId)}/trades`, TradeRowSchema, { skipped }, {}, (r) => Date.parse(String(r.executedAt ?? r.createdAt ?? "")) < since);
  }
  async marginConfig(accountId: string, asset: string) {
    const path = `/accounts/${encodeURIComponent(accountId)}/margin-config/${encodeURIComponent(asset)}`;
    return parse(MarginConfigSchema, await this.req("GET", path), `GET ${path}`);
  }
  setLeverage(accountId: string, configId: string, asset: string, leverage: number) {
    return this.req("PUT", `/accounts/${encodeURIComponent(accountId)}/margin-config/${encodeURIComponent(configId)}`, {
      body: { exchange: "hyperliquid", asset, marginMode: "cross", leverage },
    });
  }
  /** True when cancelled; false when it was already filled, cancelled or expired (Propr answers 400 then). */
  async cancelOrder(accountId: string, orderId: string): Promise<boolean> {
    try {
      await this.req("POST", `/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}/cancel`);
      return true;
    } catch (e) {
      if (e instanceof ProprError && e.status === 400) return false;
      throw e;
    }
  }
  /** Several orders go in one request under a top-level orderGroupId (perp-radar's executor sends it; Propr's published
   * schema does not list it, so `bun run propr:check` is the place to confirm it before going live). One entry per request.
   * Throws when the answer is not a list of rows: the orders may be live, but nothing about them is known. */
  async createOrders(accountId: string, body: { orderGroupId?: string; orders: ProprOrderRequest[] }): Promise<Row[]> {
    const path = `/accounts/${encodeURIComponent(accountId)}/orders`;
    return list(await this.req("POST", path, { body }), RowSchema, `POST ${path} (the orders may have been placed)`).rows;
  }
}
