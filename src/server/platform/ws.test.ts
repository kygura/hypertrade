import { describe, expect, test } from "bun:test";
import { HlSocket } from "../../shared/hl-ws";
import { Bus } from "./bus";
import { createWsIngest, parseMids, parseTrades } from "./ws";

const U1 = "0x64b766b07362405a9cc19c2226490f3015929da9";
const U2 = "0x932f9b8c0ce39cb4ea71db8584c48e696d811873";
const trade = { coin: "BTC", side: "B", px: "82866.0", sz: "2.4", time: 1792150140821, hash: "0x1", tid: 1, users: [U1, U2] };

describe("parsers", () => {
  test("trades: users extracted, malformed counted", () => {
    const r = parseTrades([trade, { ...trade, users: [U1] }, { ...trade, px: "abc" }, null])!;
    expect(r.trades.length).toBe(1);
    expect(r.trades[0]!.users).toEqual([U1, U2]);
    expect(r.bad).toBe(3);
    expect(parseTrades({})).toBeNull();
  });
  test("mids: bad entries skipped, bad envelope null", () => {
    const m = parseMids({ mids: { BTC: "100.5", ETH: "x", SOL: "0" } })!;
    expect([...m]).toEqual([["BTC", 100.5]]);
    expect(parseMids({ nope: 1 })).toBeNull();
  });
});

class FakeWs {
  static last: FakeWs;
  readyState = 1;
  sent: any[] = [];
  onopen: any; onmessage: any; onclose: any; onerror: any;
  constructor() { FakeWs.last = this; queueMicrotask(() => this.onopen?.()); }
  send(m: string) { this.sent.push(JSON.parse(m)); }
  close() { this.onclose?.(); }
  emit(o: unknown) { this.onmessage?.({ data: typeof o === "string" ? o : JSON.stringify(o) }); }
}

describe("ingest over a fake socket", () => {
  test("mid cache, age, addresses, drops, ws events", async () => {
    let t = 1_000_000;
    const bus = new Bus();
    const states: string[] = [];
    bus.subscribe("ws", (e) => states.push(e.state));
    const seen: string[][] = [];
    const ingest = createWsIngest({
      socket: new HlSocket({ create: () => new FakeWs() as unknown as WebSocket, idleCloseMs: 0 }),
      bus,
      now: () => t,
      universe: async () => ["BTC", "ETH"],
      onAddresses: (a) => seen.push(a),
    });
    (globalThis as any).WebSocket ??= FakeWs;
    await ingest.tick();
    await Promise.resolve();
    const ws = FakeWs.last;
    expect(ingest.subscribed).toBe(2);
    expect(states).toEqual(["connecting", "open"]);
    expect(ws.sent.filter((m) => m.method === "subscribe").length).toBe(3);

    ws.emit({ channel: "allMids", data: { mids: { BTC: "100" } } });
    t += 4_000;
    expect(ingest.mid("BTC")).toBe(100);
    expect(ingest.midAgeMs("BTC")).toBe(4_000);
    expect(ingest.midAgeMs("ETH")).toBeNull();
    expect(ingest.lastMessageAgeSec()).toBe(4);

    ws.emit({ channel: "trades", data: [trade, { coin: "BTC" }] });
    ws.emit("not json");
    ws.emit({ channel: "allMids", data: 5 });
    expect(seen).toEqual([[U1, U2]]);
    expect(ingest.dropped).toBe(2);
    ingest.stop();
  });
});
