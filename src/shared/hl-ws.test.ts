import { afterEach, describe, expect, jest, test } from "bun:test";
import { HlSocket } from "./hl-ws";

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: any[] = [];
  closed = 0;
  onopen: any; onmessage: any; onclose: any; onerror: any;
  constructor() { FakeWs.all.push(this); }
  send(m: string) { this.sent.push(JSON.parse(m)); }
  close() { this.closed++; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen(); }
  emit(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
(globalThis as any).WebSocket ??= FakeWs;
const subs = (w: FakeWs) => w.sent.filter((m) => m.method === "subscribe").length;
const mk = (staleMs = 0) => new HlSocket({ create: () => new FakeWs() as unknown as WebSocket, idleCloseMs: 0, staleMs });

afterEach(() => {
  jest.useRealTimers();
  FakeWs.all = [];
});

describe("HlSocket reconnect", () => {
  test("stale detection reconnects without waiting for onclose (and ignores the old socket's late close)", () => {
    jest.useFakeTimers();
    const s = mk(10_000);
    s.subscribe({ type: "allMids" }, () => {});
    FakeWs.all[0]!.open();
    const old = FakeWs.all[0]!;
    old.onclose = () => { throw new Error("must be detached"); };
    jest.advanceTimersByTime(30_000); // stale -> drop -> retry (<= 1.25 s)
    expect(old.closed).toBe(1);
    expect(FakeWs.all.length).toBe(2);
    expect(s.state).toBe("connecting");
    s.stop();
  });

  test("backoff resets only after a message, not on open", () => {
    jest.useFakeTimers();
    const s = mk();
    s.subscribe({ type: "allMids" }, () => {});
    const backoff = () => (s as any).backoff as number;
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.onclose();
    expect(backoff()).toBe(2_000);
    jest.advanceTimersByTime(1_300);
    FakeWs.all[1]!.open();
    expect(backoff()).toBe(2_000); // open alone does not reset
    FakeWs.all[1]!.emit({ channel: "allMids", data: { mids: {} } });
    expect(backoff()).toBe(1_000);
    s.stop();
  });

  test("replays subscriptions in batches of 50 every 100 ms", () => {
    jest.useFakeTimers();
    const s = mk();
    for (let i = 0; i < 120; i++) s.subscribe({ type: "trades", coin: "C" + i }, () => {});
    const w = FakeWs.all[0]!;
    w.open();
    expect(subs(w)).toBe(50);
    jest.advanceTimersByTime(100);
    expect(subs(w)).toBe(100);
    jest.advanceTimersByTime(100);
    expect(subs(w)).toBe(120);
    s.stop();
  });
});
