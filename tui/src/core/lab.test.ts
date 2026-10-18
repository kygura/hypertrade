import { expect, test } from "bun:test";
import { fetchPulse, type FetchFn } from "./lab.js";

const LAB = { url: "https://lab.example/", token: "tok-secret-123" };

const PULSE = {
  asOf: "2026-10-18T00:00:00Z",
  assets: [
    {
      asset: "BTC",
      longActive: 1,
      longTotal: 3,
      shortActive: 0,
      shortTotal: 2,
      lean: 0.2,
      rules: [{ id: "r1", name: "MVRV washout", direction: "long", firing: true, text: "cm:CapMVRVCur z(90) < -1.1" }],
    },
  ],
  warnings: [],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("fetchPulse posts to the tool route with bearer and x-lab-source and parses the result", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetchFn: FetchFn = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return json(200, { ok: true, result: PULSE });
  };
  const pulse = await fetchPulse(LAB, fetchFn);
  expect(seenUrl).toBe("https://lab.example/api/lab/tools/lab_market_pulse");
  expect(seenInit?.method).toBe("POST");
  const headers = seenInit?.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer tok-secret-123");
  expect(headers["x-lab-source"]).toBe("tui");
  expect(pulse.assets[0]?.rules[0]?.firing).toBe(true);
  expect(pulse.warnings).toEqual([]);
});

test("fetchPulse maps 401 to the unauthorized error without the token", async () => {
  const fetchFn: FetchFn = async () => json(401, { ok: false, error: "unauthorized" });
  const err = await fetchPulse(LAB, fetchFn).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe("unauthorized: check LAB_API_TOKEN");
  expect((err as Error).message).not.toContain("tok-secret");
});

test("fetchPulse reports other HTTP failures with the status and no token", async () => {
  const fetchFn: FetchFn = async () => json(500, { ok: false, error: "boom" });
  const err = (await fetchPulse(LAB, fetchFn).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("HTTP 500");
  expect(err.message).toContain("boom");
  expect(err.message).not.toContain("tok-secret");
});

test("fetchPulse rejects a result of the wrong shape", async () => {
  const fetchFn: FetchFn = async () => json(200, { ok: true, result: { asOf: "x", assets: [{ asset: "BTC" }], warnings: [] } });
  const err = (await fetchPulse(LAB, fetchFn).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("unexpected response shape");
});

test("fetchPulse rejects a non-JSON 200 body", async () => {
  const fetchFn: FetchFn = async () => new Response("<html>", { status: 200 });
  await expect(fetchPulse(LAB, fetchFn)).rejects.toThrow("unexpected response shape");
});
