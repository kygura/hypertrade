import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHealthExtras, setHealthExtras } from "../src/server/platform/runtime";
import { createHandler, start } from "./server";

let dir: string;
let handle: (r: Request) => Promise<Response>;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>spa</html>");
  writeFileSync(join(dir, "assets", "app-abc.js"), "x");
  handle = createHandler(async (r) => new Response("api:" + new URL(r.url).pathname), dir);
});
afterAll(() => rmSync(dir, { recursive: true }));
const get = (p: string) => handle(new Request("http://x" + p));

describe("server handler", () => {
  test("/api goes to the api", async () => {
    expect(await (await get("/api/health")).text()).toBe("api:/api/health");
  });
  test("hashed assets are immutable", async () => {
    const r = await get("/assets/app-abc.js");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(await r.text()).toBe("x");
  });
  test("SPA fallback and index.html no-cache", async () => {
    for (const p of ["/", "/cockpit/btc"]) {
      const r = await get(p);
      expect(await r.text()).toBe("<html>spa</html>");
      expect(r.headers.get("cache-control")).toBe("no-cache");
    }
  });
  test("missing file with extension is 404; traversal does not escape", async () => {
    expect((await get("/assets/nope.js")).status).toBe(404);
    expect(await (await get("/..%2f..%2fetc/passwd")).text()).toBe("<html>spa</html>");
  });
  test("a malformed percent-escape is a 400, not a crash", async () => {
    expect((await get("/%E0%A4%A")).status).toBe(400);
  });
});

describe("start", () => {
  test("binds and answers /api/health while boot() rejects (degraded, not down)", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const api = async () => Response.json({ ok: true, ...(await getHealthExtras()?.()) });
      const { server, booted, stop } = start({ port: 0, boot: async () => { throw new Error("migration exploded"); }, api, dist: dir });
      await booted;
      const r = await fetch(`http://localhost:${server.port}/api/health`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { loops: { name: string; ok: boolean; error: string }[] };
      expect(body.loops[0]).toMatchObject({ name: "boot", ok: false, error: "migration exploded" });
      expect(await (await fetch(`http://localhost:${server.port}/`)).text()).toBe("<html>spa</html>");
      await stop();
    } finally {
      console.error = quiet;
      setHealthExtras(null);
    }
  });
});
