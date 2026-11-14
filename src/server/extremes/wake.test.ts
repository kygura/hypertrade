import { describe, expect, test } from "bun:test";
import type { ExtremeEvent } from "../../shared/extremes.js";
import { createWaker, parseWakeHeaders, WAKE_TEXT_MAX, wakeText } from "./wake.js";

const ev = (coin: string, over: Partial<ExtremeEvent> = {}): ExtremeEvent => ({
  key: `oi_flush|${coin}|long`, kind: "oi_flush", coin, side: "long", ts: "2026-11-14T12:00:00.000Z", window: "4h", mark: 142.5, severity: 3.8,
  facts: { oiChg4h: -0.21, ret4h: -0.074, fundingApr: null }, line: `${coin} OI -21% in 4h while price -7.4%`, ...over,
});

type Call = { url: string; init: RequestInit };
function fakeFetch(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), res())) as unknown as typeof fetch;
  return { f, calls };
}
const ENV = { EXTREMES_WAKE_URL: "https://api.anthropic.com/v1/claude_code/routines/trig_x/fire", EXTREMES_WAKE_TOKEN: "sk-secret", APP_URL: "https://app.example/" };
const ok = () => Response.json({ type: "routine_fire", claude_code_session_id: "s1", claude_code_session_url: "https://claude.ai/code/s1" });

describe("wakeText", () => {
  test("data only: each key, line and facts, then the procedure and the verdict route", () => {
    const t = wakeText([ev("SOL"), ev("ETH")], "https://app.example/");
    expect(t).toContain("key: oi_flush|SOL|long");
    expect(t).toContain("key: oi_flush|ETH|long");
    expect(t).toContain("line: SOL OI -21% in 4h while price -7.4%");
    expect(t).toContain(`facts: {"oiChg4h":-0.21,"ret4h":-0.074,"fundingApr":null}`);
    expect(t).toContain("Procedure: docs/EXTREMES-ROUTINE.md");
    expect(t).toContain("POST https://app.example/api/extremes/verdict");
    expect(t).not.toContain("sk-secret");
  });

  test("stays under the endpoint's limit, dropping whole events and saying how many", () => {
    const many = Array.from({ length: 400 }, (_, i) => ev(`C${i}`, { line: "x".repeat(300) }));
    const t = wakeText(many, null);
    expect(t.length).toBeLessThanOrEqual(WAKE_TEXT_MAX);
    expect(t).toMatch(/\(\d+ more event\(s\) omitted/);
    expect(t).toContain("/api/extremes/verdict");
  });
});

describe("createWaker", () => {
  test("POSTs {text} once with the bearer, JSON content type and the routine headers", async () => {
    const { f, calls } = fakeFetch(ok);
    expect(await createWaker(ENV, f).wake([ev("SOL")])).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(ENV.EXTREMES_WAKE_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({
      "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01", "content-type": "application/json", authorization: "Bearer sk-secret",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: wakeText([ev("SOL")], ENV.APP_URL) });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("EXTREMES_WAKE_HEADERS overrides and extends the defaults; it cannot replace auth or content type", async () => {
    const { f, calls } = fakeFetch(ok);
    const headers = JSON.stringify({ "Anthropic-Beta": "other-beta", "x-extra": "1", Authorization: "Bearer evil", "Content-Type": "text/plain" });
    await createWaker({ ...ENV, EXTREMES_WAKE_HEADERS: headers }, f).wake([ev("SOL")]);
    expect(calls[0]!.init.headers).toEqual({
      "anthropic-version": "2023-06-01", "anthropic-beta": "other-beta", "x-extra": "1", "content-type": "application/json", authorization: "Bearer sk-secret",
    });
  });

  test("invalid EXTREMES_WAKE_HEADERS is ignored", async () => {
    expect(parseWakeHeaders("{not json")).toEqual({});
    expect(parseWakeHeaders("[1]")).toEqual({});
    expect(parseWakeHeaders('{"a": 1}')).toEqual({});
    const { f, calls } = fakeFetch(ok);
    expect(await createWaker({ ...ENV, EXTREMES_WAKE_HEADERS: "{nope" }, f).wake([ev("SOL")])).toBe(true);
    expect(Object.keys(calls[0]!.init.headers as object)).toEqual(["anthropic-version", "anthropic-beta", "content-type", "authorization"]);
  });

  test("unset URL or token, or no events: false without a network call", async () => {
    const { f, calls } = fakeFetch(ok);
    expect(await createWaker({}, f).wake([ev("SOL")])).toBe(false);
    expect(await createWaker({ ...ENV, EXTREMES_WAKE_TOKEN: "" }, f).wake([ev("SOL")])).toBe(false);
    expect(await createWaker(ENV, f).wake([])).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("a non-2xx answer or a network error is a failed wake, never retried", async () => {
    for (const res of [() => new Response("rate limited", { status: 429 }), () => Promise.reject(new Error("timeout"))]) {
      const { f, calls } = fakeFetch(res);
      expect(await createWaker(ENV, f).wake([ev("SOL")])).toBe(false);
      expect(calls.length).toBe(1);
    }
  });
});
