import { beforeAll, describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { TicketUi } from "../app/model.js";
import { testConfig } from "../agent/testkit.js";
import { demoAccountAddress, DemoInfo } from "../core/demo.js";
import { buildTicket } from "../core/ticket.js";
import type { AccountSnapshot, Alert, AppState, BookView, MarketRow, Ticket } from "../core/types.js";
import { BookLadder, BookStats } from "./Book.js";
import { strWidth } from "./format.js";
import { AlertLine, BannerLine } from "./lines.js";
import { MarketsTable } from "./Markets.js";
import { OrdersList, PositionsTable, PositionStrip } from "./Positions.js";
import { StatusBar, statusFields, statusLine } from "./StatusBar.js";
import { TicketCard, ticketCard } from "./Ticket.js";
import { configureTheme } from "./theme.js";

const NOW = 1_792_329_069_607;
const info = new DemoInfo(() => NOW);
let markets: MarketRow[];
let account: AccountSnapshot;
let book: BookView;

beforeAll(async () => {
  configureTheme({ color: false, ascii: false });
  markets = await info.markets();
  account = await info.account(demoAccountAddress, markets);
  book = await info.book("BTC");
});

// renderToString takes the virtual terminal width (ink-testing-library is fixed at 100 cols).
const frame = (el: React.ReactElement, columns = 160) => renderToString(el, { columns });
const lines = (s: string) => s.split("\n");
const maxWidth = (s: string) => Math.max(...lines(s).map((l) => strWidth(l)));
const state = (over: Partial<AppState> = {}): AppState => ({
  config: testConfig({ demo: false, network: "testnet" }),
  markets,
  marketsAt: NOW - 6_000,
  marketsError: null,
  account,
  accountError: null,
  alerts: [],
  ws: "open",
  ...over,
});

describe("StatusBar", () => {
  test("testnet at 120 cols shows every field", () => {
    const f = frame(<StatusBar state={state()} agentLabel="sonnet-4.5" width={120} now={NOW} />);
    expect(f).toContain(" TESTNET ");
    expect(f).toContain("eq $2,956.39");
    expect(f).toContain("uPnL +$6.39");
    expect(f).toMatch(/margin \$85 \(3%\)/);
    expect(f).toContain("pos 2");
    expect(f).toContain("orders 3");
    expect(f).toContain("ws live");
    expect(f).toContain("sonnet-4.5");
    expect(f).not.toContain("MAINNET");
  });

  test("mainnet badge is never dropped; narrow drops low-priority fields first", () => {
    const s = state({ config: testConfig({ demo: false, network: "mainnet" }), ws: "closed", alerts: [{ key: "a", level: "critical", title: "x", detail: "", at: NOW }] });
    const text = statusLine(s, "a-very-long-model-name-here", 80, NOW).map((x) => x.text).join("");
    expect(text).toContain(" MAINNET ");
    expect(text).toContain("ws down · poll 6s");
    expect(text).toContain("alerts 1");
    expect(text).not.toContain("a-very-long-model-name-here");
    expect(strWidth(text)).toBeLessThanOrEqual(80);
    expect(text).not.toContain("margin");
    const narrowMargin = statusFields(s, null, 90, NOW).find((f) => f.id === "margin")!;
    expect(narrowMargin.line[0]!.text).toBe("margin 3%");
  });

  test("demo badge first; no account; account error", () => {
    const demo = statusLine(state({ config: testConfig(), ws: "off" }), null, 120, NOW).map((x) => x.text).join("");
    expect(demo.startsWith(" DEMO ")).toBe(true);
    expect(demo).toContain("agent off");
    const none = statusLine(state({ config: testConfig({ demo: false, account: null }), account: null }), null, 120, NOW).map((x) => x.text).join("");
    expect(none).toContain("no account");
    expect(none).not.toContain("eq ");
    const err = statusLine(state({ accountError: "HTTP 500" }), null, 120, NOW).map((x) => x.text).join("");
    expect(err).toContain("acct err");
  });

  test("banner says read-only / read-write and DEMO", () => {
    expect(frame(<BannerLine info={{ network: "testnet", account: demoAccountAddress, canTrade: false, demo: false, agentLabel: null }} />)).toContain("testnet · 0xde30…de30 · read-only · agent off");
    expect(frame(<BannerLine info={{ network: "mainnet", account: null, canTrade: true, demo: false, agentLabel: "m" }} />)).toContain("read-write");
    expect(frame(<BannerLine info={{ network: "testnet", account: null, canTrade: false, demo: true, agentLabel: null }} />)).toContain("DEMO · fixtures, no network");
  });
});

describe("MarketsTable", () => {
  test("120 cols: all columns", () => {
    const f = frame(<MarketsTable rows={markets.slice(0, 5)} width={120} selected={1} offset={0} />);
    const head = lines(f)[0]!;
    for (const h of ["COIN", "MARK", "24H", "FUND/H", "APR", "PRED APR", "OI", "VOL", "PREM", "MAX"]) expect(head).toContain(h);
    expect(lines(f)[1]).toMatch(/^BTC\s+[\d,]+\.\d\s+[+-]?\d+\.\d\d%/);
    expect(maxWidth(f)).toBeLessThanOrEqual(120);
  });

  test("80 cols: FLAG, FUND/H and PREM drop", () => {
    const f = frame(<MarketsTable rows={markets.slice(0, 5)} width={80} selected={null} offset={0} />);
    const head = lines(f)[0]!;
    expect(head).not.toContain("FUND/H");
    expect(head).not.toContain("PREM");
    expect(head).toContain("PRED APR");
    expect(head).toContain("MAX");
    expect(maxWidth(f)).toBeLessThanOrEqual(80);
  });
});

describe("positions", () => {
  test("table at 120 and 80 cols; missing stop reads —", () => {
    const sz = Object.fromEntries(markets.map((m) => [m.coin, m.szDecimals]));
    const wide = frame(<PositionsTable positions={account.positions} width={120} szDecimals={sz} />);
    expect(lines(wide)[0]).toContain("→LIQ");
    expect(lines(wide)[0]).toContain("TP");
    expect(wide).toMatch(/BTC\s+LONG\s+0\.00500/);
    expect(lines(wide)[2]).toMatch(/ETH\s+SHORT/);
    expect(lines(wide)[2]).toContain("—");
    const narrow = frame(<PositionsTable positions={account.positions} width={80} szDecimals={sz} />);
    expect(lines(narrow)[0]).not.toContain("ENTRY");
    expect(lines(narrow)[0]).not.toContain(" TP");
    expect(maxWidth(narrow)).toBeLessThanOrEqual(80);
  });

  test("orders one-liner and the position strip", () => {
    const o = frame(<OrdersList orders={account.orders} width={120} now={NOW} />);
    expect(o).toContain("900000001 BTC sell 0.005 stop 78,287.7 sl·ro");
    const s = frame(<PositionStrip positions={account.positions} width={120} />);
    expect(s).toContain("BTC L +$6.15 stop -4.5%");
    expect(s).toContain("ETH S +$0.24 no stop");
    const tight = frame(<PositionStrip positions={account.positions} width={36} />);
    expect(tight).toContain("+1 more");
  });
});

describe("BookLadder", () => {
  test("asks above the spread, bids below, bar only ≥ 100 cols", () => {
    const f = frame(<BookLadder book={book} levels={3} szDecimals={5} width={120} />);
    const ls = lines(f);
    expect(ls[0]).toContain("CUM USD");
    expect(ls[4]).toContain("spread");
    const askPx = Number(ls[3]!.trim().split(/\s+/)[0]!.replace(/,/g, ""));
    const bidPx = Number(ls[5]!.trim().split(/\s+/)[0]!.replace(/,/g, ""));
    expect(askPx).toBeGreaterThan(bidPx);
    expect(f).toContain("█");
    expect(frame(<BookLadder book={book} levels={3} szDecimals={5} width={90} />)).not.toContain("█");
    const stats = frame(<BookStats book={book} />);
    expect(stats).toContain("±50bps");
    expect(stats).toContain("BUY bps");
  });
});

describe("TicketCard", () => {
  let base: Ticket;
  const ui = (over: Partial<TicketUi> = {}): TicketUi => ({ phase: "awaiting", source: "command", access: "trade", slippage: 0.01, szDecimals: 2, ...over });
  beforeAll(async () => {
    base = await buildTicket(
      { kind: "open", intent: { asset: "HYPE", side: "long", leverage: 3, size: { usd: 1 }, entry: { type: "market" }, stop: { type: "pct", pct: 2 }, target: 82 }, riskPct: 0.5 },
      { config: testConfig({ demo: false, canTrade: true }), info, markets, account, id: () => "t-3f2a", now: () => new Date(NOW) },
    );
  });

  test("quoted: frame, headline, rows, governor PASS, y send footer, within width", () => {
    expect(base.canSend).toBe(true);
    const f = frame(<TicketCard ticket={base} ui={ui()} width={120} />);
    const ls = lines(f);
    expect(ls[0]).toMatch(/^╭─ TICKET t-3f2a · OPEN · from command ─+ TESTNET ─╮$/);
    expect(strWidth(ls[0]!)).toBe(80);
    expect(f).toMatch(/LONG HYPE {3}\d+\.\d\d HYPE {3}≈ \$[\d,.]+ notional {3}3x cross {3}market IOC ±1%/);
    expect(f).toContain("entry ≈");
    expect(f).toContain("risk");
    expect(f).toContain("governor  PASS");
    expect(f).toMatch(/│ y send · n discard\s+quoted \d\d:\d\d:\d\d │/);
    expect(maxWidth(f)).toBe(80);
    expect(ls[ls.length - 1]).toMatch(/^╰─+╯$/);
  });

  test("changed: warn line and (was …) for changed fields", () => {
    const next: Ticket = { ...base, entryPx: base.entryPx! * 1.01, notionalUsd: base.notionalUsd! + 5 };
    const f = frame(<TicketCard ticket={next} ui={ui({ changedWhy: "mark moved +1.0%", previous: base })} width={120} />);
    expect(f).toContain("! re-quoted: mark moved +1.0%");
    expect(f).toContain("(was ");
    expect(f).toContain("y send new quote · n discard");
  });

  test("read-only: no y", () => {
    const t = { ...base, canSend: false, blockers: ["read-only: no HT_AGENT_KEY"] };
    const f = frame(<TicketCard ticket={t} ui={ui({ access: "read-only" })} width={120} />);
    expect(f).toContain("read-only: no key · n/esc dismiss");
    expect(f).toContain("✗ read-only: no HT_AGENT_KEY");
    expect(f).not.toContain("y send");
  });

  test("mainnet: badge, warning line, y send on MAINNET", () => {
    const t = { ...base, network: "mainnet" as const };
    const f = frame(<TicketCard ticket={t} ui={ui()} width={120} />);
    expect(lines(f)[0]).toContain(" MAINNET ─╮");
    expect(f).toContain("MAINNET · real funds · sending is irreversible");
    expect(f).toContain("y send on MAINNET · n discard");
  });

  test("demo: simulated footer and DEMO badge; blocked ticket", () => {
    const d = { ...base, canSend: false, blockers: ["demo: orders disabled"] };
    const f = frame(<TicketCard ticket={d} ui={ui({ access: "demo" })} width={120} />);
    expect(f).toContain("y send (demo, simulated) · n discard");
    expect(lines(f)[0]).toContain(" DEMO ─╮");
    const rejected = { ...base, canSend: false, blockers: ["already long HYPE"], verdict: { ...base.verdict!, approved: false, reasons: ["already long HYPE"] } };
    const r = frame(<TicketCard ticket={rejected} ui={ui()} width={120} />);
    expect(r).toContain("governor  REJECTED");
    expect(r).toContain("blocked · n/esc dismiss");
    expect(r.match(/already long HYPE/g)!.length).toBe(1);
  });

  test("narrow: card is cols − 2 and clips to maxHeight", () => {
    const f = frame(<TicketCard ticket={base} ui={ui()} width={80} maxHeight={10} />);
    expect(maxWidth(f)).toBe(78);
    expect(lines(f).length).toBeLessThanOrEqual(10);
    expect(f).toContain("more line");
  });

  test("ticketCard: verdict CLIPPED when a warning says clipped", () => {
    const t = { ...base, verdict: { ...base.verdict!, warnings: ["size clipped by coin leverage"] } };
    const m = ticketCard(t, ui(), NOW);
    expect(m.body.some((l) => l.map((s) => s.text).join("").includes("CLIPPED"))).toBe(true);
  });
});

describe("AlertLine", () => {
  const a = (level: Alert["level"]): Alert => ({ key: level, level, title: "ETH no stop on open position", detail: "short 1.2000 ETH, liq 4,980.2 (+49.2%)", at: NOW });
  test("levels carry words, not just color", () => {
    expect(frame(<AlertLine alert={a("warn")} width={116} />)).toMatch(/^! WARN {3}\d\d:\d\d:\d\d {2}ETH no stop on open position · short 1\.2000 ETH/);
    expect(frame(<AlertLine alert={a("critical")} width={116} />)).toMatch(/^!! CRIT/);
    expect(frame(<AlertLine alert={a("info")} width={116} />)).toMatch(/^· INFO/);
  });
  test("detail wraps under the title", () => {
    const f = frame(<AlertLine alert={a("warn")} width={50} />);
    const ls = lines(f);
    expect(ls.length).toBeGreaterThan(1);
    expect(ls[1]!.startsWith(" ".repeat(19))).toBe(true);
  });
});
