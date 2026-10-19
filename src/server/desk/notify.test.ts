import { describe, expect, test } from "bun:test";
import { createNotifier } from "./notify.js";

function recorder() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("ntfy channel", () => {
  test("default server and info priority: POST to <server>/<topic> with Title and Priority", async () => {
    const { calls, fetchFn } = recorder();
    const sent = await createNotifier({ NTFY_TOPIC: "desk" }, fetchFn).send({ level: "info", title: "Funding hot", body: "BTC funding +0.05%" });
    expect(sent).toEqual(["ntfy"]);
    expect(calls.map((c) => c.url)).toEqual(["https://ntfy.sh/desk"]);
    expect(calls[0]!.init).toMatchObject({ method: "POST", body: "BTC funding +0.05%" });
    expect(calls[0]!.init.headers).toEqual({ Title: "Funding hot", Priority: "3" });
  });

  test("custom server, token and click; title stripped to printable ASCII; body capped at 4000", async () => {
    const { calls, fetchFn } = recorder();
    const env = { NTFY_TOPIC: "desk alerts", NTFY_SERVER: "https://ntfy.example/", NTFY_TOKEN: "tk" };
    await createNotifier(env, fetchFn).send({ level: "critical", title: "Liq near ✗BTC", body: "x".repeat(5000), click: "https://app.example/desk" });
    expect(calls[0]!.url).toBe("https://ntfy.example/desk%20alerts");
    expect(calls[0]!.init.headers).toEqual({ Title: "Liq near BTC", Priority: "5", Click: "https://app.example/desk", Authorization: "Bearer tk" });
    expect((calls[0]!.init.body as string).length).toBe(4000);
  });

  test("429 is retried once after Retry-After: one delivery", async () => {
    const statuses = [429, 200];
    const calls: string[] = [];
    const waits: number[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(String(url));
      const status = statuses.shift()!;
      return new Response("", { status, headers: status === 429 ? { "retry-after": "7" } : {} });
    }) as unknown as typeof fetch;
    const sent = await createNotifier({ NTFY_TOPIC: "desk" }, fetchFn, async (ms) => void waits.push(ms)).send({ level: "info", title: "t", body: "b" });
    expect(sent).toEqual(["ntfy"]);
    expect(calls.length).toBe(2);
    expect(waits).toEqual([7000]);
  });
});
