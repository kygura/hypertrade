import { describe, expect, test } from "bun:test";
import { AlertEngine } from "./alerts.js";
import { demoAccountAddress, DemoInfo } from "./demo.js";
import { Store, type SocketLike, wsUrl } from "./store.js";
import type { Alert, Config, InfoSource } from "./types.js";
import type { HlSocketState, HlSub } from "../../../src/shared/hl-ws.js";

const T0 = 1_800_000_000_000;

const config = (over: Partial<Config> = {}): Config => ({
  network: "testnet",
  account: "0xabc",
  canTrade: false,
  maxNotionalUsd: 1000,
  slippage: 0.01,
  watch: ["BTC", "ETH"],
  limits: { maxRiskPct: 1, maxOpenRiskPct: 3, maxGrossLeverage: 5, maxCoinLeverage: 3, maxPositions: 5, minRewardRisk: 1.5 },
  defaultLeverage: 3,
  lab: null,
  demo: false,
  ...over,
});

class FakeTimers {
  clock = T0;
  fns = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  setInterval = (fn: () => void, ms: number) => {
    this.fns.set(++this.n, { fn, ms });
    return this.n;
  };
  clearInterval = (h: unknown) => void this.fns.delete(h as number);
  now = () => this.clock;
  /** Fires every interval whose period is `ms`. */
  tick(ms: number) {
    for (const t of [...this.fns.values()]) if (t.ms === ms) t.fn();
  }
}

class FakeSocket implements SocketLike {
  url = "";
  subs: HlSub[] = [];
  handler: ((d: unknown) => void) | null = null;
  stateCb: ((s: HlSocketState) => void) | null = null;
  stopped = false;
  subscribe(sub: HlSub, handler: (d: unknown) => void) {
    this.subs.push(sub);
    this.handler = handler;
    return () => {};
  }
  onState(cb: (s: HlSocketState) => void) {
    this.stateCb = cb;
    return () => {};
  }
  stop() {
    this.stopped = true;
  }
  mids(mids: Record<string, string>) {
    this.handler!({ mids });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(over: Partial<Config> = {}, info: InfoSource = new DemoInfo(() => T0), extra: { alerts?: AlertEngine } = {}) {
  const timers = new FakeTimers();
  const sock = new FakeSocket();
  const store = new Store({
    config: config(over),
    info,
    socket: (url) => ((sock.url = url), sock),
    now: timers.now,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    marketsEveryMs: 15_000,
    accountEveryMs: 10_000,
    ...extra,
  });
  return { store, timers, sock };
}

describe("Store", () => {
  test("initial state is empty and the socket is closed", () => {
    const { store } = setup();
    const s = store.getState();
    expect(s.markets).toEqual([]);
    expect(s.account).toBeNull();
    expect(s.ws).toBe("closed");
    expect(s.marketsAt).toBeNull();
  });

  test("start loads markets and account, opens the socket on the network's URL, schedules two polls", async () => {
    const { store, timers, sock } = setup();
    await store.start();
    const s = store.getState();
    expect(s.markets.length).toBeGreaterThan(30);
    expect(s.marketsAt).toBe(T0);
    expect(s.account?.positions).toHaveLength(2);
    expect(s.accountError).toBeNull();
    expect(sock.url).toBe("wss://api.hyperliquid-testnet.xyz/ws");
    expect(sock.subs).toEqual([{ type: "allMids" }]);
    expect([...timers.fns.values()].map((t) => t.ms).sort()).toEqual([10_000, 15_000]);
    expect(s.ws).toBe("connecting");
    store.stop();
  });

  test("wsUrl follows the network", () => {
    expect(wsUrl("mainnet")).toBe("wss://api.hyperliquid.xyz/ws");
  });

  test("the first evaluation sees the account: the no-stop alert is published and active", async () => {
    const { store } = setup();
    const seen: Alert[] = [];
    store.onAlert((a) => seen.push(a));
    await store.start();
    expect(seen.map((a) => a.key)).toContain("nostop:ETH");
    expect(store.getState().alerts.map((a) => a.key)).toContain("nostop:ETH");
    store.stop();
  });

  test("polls: the markets timer refreshes markets (and does not repeat an alert inside the cooldown)", async () => {
    let calls = 0;
    const demo = new DemoInfo(() => T0);
    const info: InfoSource = { ...bind(demo), markets: async () => (calls++, demo.markets()) };
    const { store, timers } = setup({}, info);
    const seen: Alert[] = [];
    store.onAlert((a) => seen.push(a));
    await store.start();
    const n = seen.length;
    timers.clock += 15_000;
    timers.tick(15_000);
    await flush();
    expect(calls).toBe(2);
    expect(store.getState().marketsAt).toBe(T0 + 15_000);
    expect(seen).toHaveLength(n);
    store.stop();
  });

  test("the account timer refreshes the account", async () => {
    let calls = 0;
    const demo = new DemoInfo(() => T0);
    const { store, timers } = setup({}, { ...bind(demo), account: async (a, m) => (calls++, demo.account(a, m)) });
    await store.start();
    timers.tick(10_000);
    await flush();
    expect(calls).toBe(2);
    store.stop();
  });

  test("allMids sets midPx on rows and ignores malformed or unknown data", async () => {
    const { store, sock } = setup();
    await store.start();
    const btc = store.getState().markets.find((m) => m.coin === "BTC")!;
    expect(btc.midPx).toBeNull();
    sock.mids({ BTC: "123.5", "@107": "1", NOPE: "5" });
    sock.handler!({ garbage: true });
    sock.mids({ ETH: "not-a-number" });
    const m = store.getState().markets;
    expect(m.find((r) => r.coin === "BTC")!.midPx).toBe(123.5);
    expect(m.find((r) => r.coin === "BTC")!.markPx).toBe(btc.markPx);
    expect(m.find((r) => r.coin === "ETH")!.midPx).toBeNull();
    store.stop();
  });

  test("mids survive the next poll", async () => {
    const { store, sock, timers } = setup();
    await store.start();
    sock.mids({ BTC: "99" });
    timers.tick(15_000);
    await flush();
    expect(store.getState().markets.find((r) => r.coin === "BTC")!.midPx).toBe(99);
    store.stop();
  });

  test("mid-driven notifications are throttled to 4 per second but state stays current", async () => {
    const { store, sock, timers } = setup();
    await store.start();
    let n = 0;
    store.subscribe(() => n++);
    for (let i = 1; i <= 10; i++) {
      timers.clock += 50; // 20 msgs/s
      sock.mids({ BTC: String(100 + i) });
    }
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3); // 500 ms of messages
    expect(store.getState().markets.find((r) => r.coin === "BTC")!.midPx).toBe(110);
    store.stop();
  });

  test("ws state follows the socket", async () => {
    const { store, sock } = setup();
    await store.start();
    sock.stateCb!("open");
    expect(store.getState().ws).toBe("open");
    sock.stateCb!("closed");
    expect(store.getState().ws).toBe("closed");
    store.stop();
  });

  test("account errors land in accountError and keep the last account; recovery clears it", async () => {
    const demo = new DemoInfo(() => T0);
    let fail = false;
    const { store } = setup({}, { ...bind(demo), account: async (a, m) => (fail ? Promise.reject(new Error("HL 500")) : demo.account(a, m)) });
    await store.start();
    fail = true;
    await store.refreshAccount();
    expect(store.getState().accountError).toBe("HL 500");
    expect(store.getState().account).not.toBeNull();
    fail = false;
    await store.refreshAccount();
    expect(store.getState().accountError).toBeNull();
    store.stop();
  });

  test("a failing markets poll keeps the last markets and does not throw", async () => {
    const demo = new DemoInfo(() => T0);
    let fail = false;
    const { store, timers } = setup({}, { ...bind(demo), markets: async () => (fail ? Promise.reject(new Error("down")) : demo.markets()) });
    await store.start();
    const before = store.getState().markets;
    fail = true;
    timers.clock += 15_000;
    timers.tick(15_000);
    await flush();
    await store.refreshMarkets();
    expect(store.getState().markets).toBe(before);
    expect(store.getState().marketsAt).toBe(T0);
    store.stop();
  });

  test("a failing first markets read still lets start() resolve", async () => {
    const demo = new DemoInfo(() => T0);
    const { store } = setup({}, { ...bind(demo), markets: async () => Promise.reject(new Error("down")) });
    await store.start();
    expect(store.getState().markets).toEqual([]);
    store.stop();
  });

  test("throwing subscribers and alert listeners do not break the store", async () => {
    const { store } = setup();
    store.subscribe(() => {
      throw new Error("ui bug");
    });
    store.onAlert(() => {
      throw new Error("ui bug");
    });
    await store.start();
    expect(store.getState().account).not.toBeNull();
    expect(store.getState().accountError).toBeNull();
    store.stop();
  });

  test("unsubscribe stops notifications", async () => {
    const { store } = setup();
    let n = 0;
    const off = store.subscribe(() => n++);
    await store.refreshMarkets();
    const after = n;
    off();
    await store.refreshMarkets();
    expect(n).toBe(after);
  });

  test("no configured account: no account reads and no error", async () => {
    let calls = 0;
    const demo = new DemoInfo(() => T0);
    const { store } = setup({ account: null }, { ...bind(demo), account: async (a, m) => (calls++, demo.account(a, m)) });
    await store.start();
    expect(calls).toBe(0);
    expect(store.getState().account).toBeNull();
    expect(store.getState().accountError).toBeNull();
    store.stop();
  });

  test("demo mode: no socket, ws off, the demo address is used", async () => {
    const asked: string[] = [];
    const demo = new DemoInfo(() => T0);
    const timers = new FakeTimers();
    const store = new Store({
      config: config({ demo: true, account: null }),
      info: { ...bind(demo), account: async (a, m) => (asked.push(a), demo.account(a, m)) },
      socket: () => {
        throw new Error("no socket in demo");
      },
      now: timers.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    expect(store.getState().ws).toBe("off");
    await store.start();
    expect(store.getState().ws).toBe("off");
    expect(asked).toEqual([demoAccountAddress]);
    expect(store.getState().account).not.toBeNull();
    store.stop();
    expect(store.getState().ws).toBe("off");
  });

  test("stop clears timers and stops the socket", async () => {
    const { store, timers, sock } = setup();
    await store.start();
    store.stop();
    expect(timers.fns.size).toBe(0);
    expect(sock.stopped).toBe(true);
    expect(store.getState().ws).toBe("closed");
  });

  test("overlapping polls are skipped while one is in flight", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const demo = new DemoInfo(() => T0);
    const { store } = setup({}, { ...bind(demo), markets: async () => (calls++, await gate, demo.markets()) });
    const a = store.refreshMarkets();
    const b = store.refreshMarkets();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

/** InfoSource methods bound to an instance so they can be spread into overrides. */
function bind(i: InfoSource): InfoSource {
  return {
    markets: () => i.markets(),
    account: (a, m) => i.account(a, m),
    book: (c) => i.book(c),
    candles: (c, iv, s) => i.candles(c, iv, s),
    fundingHistory: (c, s) => i.fundingHistory(c, s),
  };
}
