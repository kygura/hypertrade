// Full app in demo mode, driven through stdin like a user. No network: DemoInfo,
// no exchange (demo), and a fake agent.
import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { ARM_DELAY_MS, Controller, type AgentLike } from "../app/controller.js";
import { loadConfig } from "../core/config.js";
import { DemoInfo } from "../core/demo.js";
import { Store } from "../core/store.js";
import { App } from "./App.js";
import { configureTheme } from "./theme.js";

afterEach(() => cleanup());

const tick = () => new Promise((r) => setTimeout(r, 15));

async function waitFor(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("demo: markets → esc → pos → book → long HYPE → y (simulated) → quit", async () => {
  configureTheme({ color: false, ascii: false });
  const { config } = loadConfig({}, ["--demo"]);
  const info = new DemoInfo();
  const store = new Store({ config, info, setInterval: () => 0, clearInterval: () => {} });
  const agent: AgentLike = {
    ask: async () => {
      throw new Error("agent must not be called in this flow");
    },
    clear: () => {},
  };
  let quit = 0;
  const ctl = new Controller({ config, store, info, exchange: null, agent, agentLabel: "fake-1", batchMs: 0, onQuit: () => quit++ });
  const app = render(<App controller={ctl} columns={100} rows={40} />);
  await store.start();
  const out = () => app.lastFrame() ?? "";
  const type = async (s: string) => {
    app.stdin.write(s);
    await tick();
    app.stdin.write("\r");
    await tick();
  };

  await waitFor(() => out().includes(" DEMO ") && out().includes("eq $"), "status bar");
  expect(out()).toContain("ht 0.1 · DEMO · fixtures, no network");
  expect(out()).toContain(" TESTNET ");
  expect(out()).toContain("agent fake-1");
  // the fixture account's stopless ETH short raises an alert line
  await waitFor(() => /!! CRIT {2}\d\d:\d\d:\d\d {2}ETH has no stop/.test(out()), "alert line");

  await type("/markets");
  await waitFor(() => out().includes(" MARKETS "), "markets overlay");
  expect(out()).toMatch(/BTC\s+[\d,]+\.\d/);
  expect(out()).toContain("esc close");
  app.stdin.write("\u001b");
  await waitFor(() => !out().includes(" MARKETS ") && ctl.getView().mode === "prompt", "overlay closed");

  await type("/pos");
  await waitFor(() => out().includes("POSITIONS ·"), "positions snapshot");
  expect(out()).toMatch(/BTC\s+LONG/);
  expect(out()).toMatch(/ETH\s+SHORT/);

  await type("/book BTC");
  await waitFor(() => out().includes(" BOOK BTC ") && out().includes("CUM USD"), "book overlay");
  app.stdin.write("\u001b");
  await waitFor(() => out().includes("BOOK BTC ·") && ctl.getView().mode === "prompt", "book summary");

  await type("/long HYPE risk 0.5% stop 2% tp 2R");
  await waitFor(() => out().includes("TICKET ") && out().includes("y send (demo, simulated)"), "ticket card");
  expect(out()).toContain("governor  PASS");
  expect(out()).toContain("ticket pending: y send · n discard");
  expect(ctl.getView().mode).toBe("ticket");

  // y is armed only ARM_DELAY_MS after the ticket appears
  app.stdin.write("y");
  await tick();
  expect(ctl.getView().mode).toBe("ticket");
  await new Promise((r) => setTimeout(r, ARM_DELAY_MS + 50));
  app.stdin.write("y");
  await waitFor(() => out().includes("demo: simulated, nothing sent"), "simulated result");
  expect(out()).toContain("simulated");
  expect(ctl.getView().mode).toBe("prompt");

  // text + Enter in ONE read (paste, fast typist) submits
  app.stdin.write("/coin BTC\r");
  await waitFor(() => out().includes("ATR14"), "coin card from a single chunk");
  expect(ctl.getView().input).toBe("");

  await type("/quit");
  await waitFor(() => quit === 1, "quit");
  store.stop();
});
