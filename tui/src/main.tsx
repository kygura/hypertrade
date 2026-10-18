// ht entry point: config → info source → store → exchange → agent → controller → Ink.
// The agent key goes only to verifyAgent and createExchange; it is never logged.
import { render } from "ink";
import { createAgent } from "./agent/loop.js";
import { Controller, makeAgentDeps } from "./app/controller.js";
import { loadBrief } from "./core/brief.js";
import { loadConfig, verifyAgent } from "./core/config.js";
import { DemoInfo } from "./core/demo.js";
import { createExchange } from "./core/exchange.js";
import { HlInfo } from "./core/info.js";
import { fetchPulse } from "./core/lab.js";
import { Store } from "./core/store.js";
import type { InfoSource } from "./core/types.js";
import { App } from "./ui/App.js";
import { configureTheme, colorEnabled } from "./ui/theme.js";

const IN_FLIGHT_WAIT_MS = 10_000;

async function main(): Promise<void> {
  configureTheme({ color: colorEnabled(process.env, !!process.stdout.isTTY), ascii: process.env.HT_ASCII === "1" });

  const loaded = loadConfig(process.env, process.argv.slice(2));
  let { config } = loaded;
  const { agentKey } = loaded;
  const warnings = [...loaded.warnings];
  if (!config.demo && agentKey) {
    const v = await verifyAgent(config, agentKey);
    config = v.config;
    warnings.push(...v.warnings);
  }
  for (const w of warnings) process.stderr.write(`ht: ${w}\n`);

  const info: InfoSource = config.demo ? new DemoInfo() : new HlInfo(config.network);
  const store = new Store({ config, info });
  const exchange = config.canTrade ? createExchange(config, agentKey) : null;
  const lab = config.lab;
  const pulse = lab ? () => fetchPulse(lab) : null;
  const brief = () => loadBrief();

  let controller: Controller | null = null;
  const deps = makeAgentDeps({ store, info, pulse, brief, controller: () => controller! });
  const { agent, label, reason } = createAgent(process.env, deps);

  let exiting = false;
  const instance = { unmount: () => {} };
  controller = new Controller({
    config,
    store,
    info,
    exchange,
    agent,
    agentLabel: label,
    ...(reason ? { agentReason: reason } : {}),
    pulse,
    brief,
    onQuit: () => {
      if (exiting) return;
      exiting = true;
      store.stop();
      instance.unmount();
    },
  });

  if (!process.stdin.isTTY) process.stderr.write("ht: stdin is not a terminal: keys disabled; send SIGINT or SIGTERM to exit\n");
  const ink = render(<App controller={controller} />, { exitOnCtrlC: false });
  // Signals (non-TTY stdin, kill, timeout) take the same path as /quit.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => controller?.quit());
  instance.unmount = () => ink.unmount();
  void store.start().catch((e: unknown) => process.stderr.write(`ht: start failed: ${e instanceof Error ? e.message : String(e)}\n`));
  await ink.waitUntilExit();
  store.stop();
  await awaitInFlight(controller);
  process.exit(0);
}

/** An order confirmed before quitting is allowed to finish (up to 10 s); its outcome goes to stderr. */
async function awaitInFlight(c: Controller): Promise<void> {
  const pending = c.inFlight();
  if (!pending) return;
  process.stderr.write("ht: waiting for the order in flight…\n");
  const done = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), IN_FLIGHT_WAIT_MS))]);
  if (!done) {
    process.stderr.write("ht: order status unknown after 10s: check /pos after restart\n");
    return;
  }
  const head = done.outcome === "sent" ? "sent" : done.outcome === "failed" ? "not sent" : "outcome uncertain, check /pos after restart";
  process.stderr.write(`ht: ticket ${done.ticket.id}: ${head}\n`);
  for (const l of done.result.lines) process.stderr.write(`ht:   · ${l}\n`);
  for (const e of done.result.errors) process.stderr.write(`ht:   ✗ ${e}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`ht: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
