// Propr REST client (docs: propr.xyz/developers, propr.xyz/openapi.json), ported from perp-radar's executor.
// The key comes only from PROPR_API_KEY. It is held in a private field, sent only in the X-API-Key header to
// Propr's own hosts, and scrubbed from every error message. Every answer is parsed with zod (schemas.ts): a shape the
// desk does not know throws, it never reads as an empty list.

import type { z } from "zod";
import { AccountSchema, AttemptRowSchema, ListSchema, MarginConfigSchema, OrderRowSchema, PositionRowSchema, RowSchema, TradeRowSchema, type Row } from "./schemas.js";

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

/** Parses an answer, or throws naming the request and the first thing that did not fit. */
function parse<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw new ProprError(200, null, scrub(`${what}: answer not in a shape the desk knows (${i ? `${i.path.join(".") || "body"}: ${i.message}` : "invalid"})`));
}
/** The rows of a list answer and the total it reports, each row parsed. */
function list<S extends z.ZodTypeAny>(body: unknown, row: S, what: string): { rows: Array<z.infer<S>>; total: number | null } {
  const b = parse(ListSchema, body, what);
  const raw = Array.isArray(b) ? b : b.data;
  return { rows: raw.map((r, i) => parse(row, r, `${what} row ${i}`)), total: Array.isArray(b) ? null : (b.total ?? null) };
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
  private async all<S extends z.ZodTypeAny>(path: string, row: S, params: Record<string, string | number | undefined> = {}, until?: (r: z.infer<S>) => boolean): Promise<Array<z.infer<S>>> {
    const out: Array<z.infer<S>> = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { rows: got, total } = list(await this.req("GET", path, { params: { ...params, limit: PAGE, offset: page * PAGE } }), row, `GET ${path}`);
      out.push(...got);
      if (got.length < PAGE || (total != null && out.length >= total) || (until && got.length && until(got[got.length - 1]!))) break;
    }
    return out;
  }

  /** Challenge attempts that can trade (active, or passed and funded). */
  async attempts(): Promise<Row[]> {
    return (await this.all("/challenge-attempts", AttemptRowSchema)).filter((a) => TRADABLE.has(String(a.status)));
  }
  /** Balance, margin balance, unrealized P&L (the SDK's get_account). */
  async account(accountId: string): Promise<Row> {
    const path = `/accounts/${encodeURIComponent(accountId)}`;
    return parse(AccountSchema, await this.req("GET", path), `GET ${path}`);
  }
  positions(accountId: string): Promise<Row[]> {
    return this.all(`/accounts/${encodeURIComponent(accountId)}/positions`, PositionRowSchema, { status: "open" });
  }
  /** Every order (open ones can be days old: a held position's stop), up to a thousand. */
  orders(accountId: string): Promise<Row[]> {
    return this.all(`/accounts/${encodeURIComponent(accountId)}/orders`, OrderRowSchema);
  }
  /** Trades back to `since` (the day's realized P&L). */
  trades(accountId: string, since: number): Promise<Row[]> {
    return this.all(`/accounts/${encodeURIComponent(accountId)}/trades`, TradeRowSchema, {}, (r) => Date.parse(String(r.executedAt ?? r.createdAt ?? "")) < since);
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
