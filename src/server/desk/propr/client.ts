// Propr REST client (docs: propr.xyz/developers, propr.xyz/openapi.json), ported from perp-radar's executor.
// The key comes only from PROPR_API_KEY. It is held in a private field, sent only in the X-API-Key header to
// Propr's own hosts, and scrubbed from every error message.

const HOSTS = new Set(["api.propr.xyz", "api.beta.propr.xyz"]);
export const PROPR_LIVE_URL = "https://api.propr.xyz/v1";
const TIMEOUT_MS = 15_000;

export class ProprError extends Error {
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

export type Row = Record<string, unknown>;
type Rows = { data?: Row[] } | Row[];
const rows = (b: Rows): Row[] => (Array.isArray(b) ? b : (b.data ?? []));

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

  private async req<T>(method: "GET" | "POST" | "PUT", path: string, opts: { params?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth !== false) headers["x-api-key"] = this.#key;
    let r: Response;
    try {
      r = await this.fetchFn(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(TIMEOUT_MS) });
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
    return (await r.json()) as T;
  }

  async activeAttempts(): Promise<Row[]> {
    return rows(await this.req<Rows>("GET", "/challenge-attempts", { params: { status: "active", limit: 20 } }));
  }
  /** Balance, margin balance, unrealized P&L (the SDK's get_account). */
  account(accountId: string): Promise<Row> {
    return this.req<Row>("GET", `/accounts/${encodeURIComponent(accountId)}`);
  }
  async positions(accountId: string): Promise<Row[]> {
    return rows(await this.req<Rows>("GET", `/accounts/${encodeURIComponent(accountId)}/positions`, { params: { status: "open", limit: 100 } }));
  }
  async orders(accountId: string): Promise<Row[]> {
    return rows(await this.req<Rows>("GET", `/accounts/${encodeURIComponent(accountId)}/orders`, { params: { limit: 100 } }));
  }
  async trades(accountId: string): Promise<Row[]> {
    return rows(await this.req<Rows>("GET", `/accounts/${encodeURIComponent(accountId)}/trades`, { params: { limit: 100 } }));
  }
  marginConfig(accountId: string, asset: string) {
    return this.req<{ configId: string; leverage: string; marginMode: string }>("GET", `/accounts/${encodeURIComponent(accountId)}/margin-config/${encodeURIComponent(asset)}`);
  }
  setLeverage(accountId: string, configId: string, asset: string, leverage: number) {
    return this.req<unknown>("PUT", `/accounts/${encodeURIComponent(accountId)}/margin-config/${encodeURIComponent(configId)}`, {
      body: { exchange: "hyperliquid", asset, marginMode: "cross", leverage },
    });
  }
  /** True when cancelled; false when it was already filled, cancelled or expired (Propr answers 400 then). */
  async cancelOrder(accountId: string, orderId: string): Promise<boolean> {
    try {
      await this.req<unknown>("POST", `/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}/cancel`);
      return true;
    } catch (e) {
      if (e instanceof ProprError && e.status === 400) return false;
      throw e;
    }
  }
  /** Several orders need a top-level orderGroupId; one entry per request. */
  async createOrders(accountId: string, body: { orderGroupId?: string; orders: ProprOrderRequest[] }): Promise<Row[]> {
    return rows(await this.req<Rows>("POST", `/accounts/${encodeURIComponent(accountId)}/orders`, { body }));
  }
}
