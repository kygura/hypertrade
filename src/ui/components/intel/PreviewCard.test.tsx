import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { OrderPreview } from "../../../shared/intel";
import { PreviewCard } from "./PreviewCard";
import { confirmBlock, createSingleFlight, fmtCountdown, previewRemainingMs, STALE_TEXT, venueOf } from "./order";

// Render-check (react-dom/server, no jsdom), the ClaimLine.test.tsx approach:
// DESIGN-terminal §7.3/§7.4 markup, plus the pure confirm gates.

function preview(over: Partial<OrderPreview> = {}, receivedAt = Date.now()): OrderPreview {
  return {
    intent: { asset: "ETH", side: "long", leverage: 3, size: { usd: 1500 }, entry: { type: "market" }, stop: { type: "prev_day_low" } },
    resolved: { stopPx: 3412.5, entryPx: 3600.1, size: 0.42, notionalUsd: 1512, liqPx: 2431, riskPct: 0.8, riskUsd: 78.9 },
    verdict: { decision: "approve", approved: true, reasons: [], warnings: [], equityUsd: 10_000, checkedAt: new Date(receivedAt).toISOString() },
    warnings: [],
    notes: ["entry = market, resolved at mark 3,600.1", "stop = yesterday's low 3,412.5 (2026-10-12 UTC candle) (−5.21% from entry)"],
    assumptions: ["leverage defaulted to 3x"],
    venue: "paper",
    previewHash: "abcdef0123456789",
    markPx: 3600.1,
    expiresAt: new Date(receivedAt + 60_000).toISOString(),
    ...over,
  };
}

const noop = () => {};
const render = (p: OrderPreview, receivedAt: number, extra: Partial<Parameters<typeof PreviewCard>[0]> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PreviewCard preview={p} venue="paper" receivedAt={receivedAt} stale={null} onConfirm={noop} onRepreview={noop} {...extra} />
    </MemoryRouter>,
  );

const confirmButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*CONFIRM PAPER ORDER(?:(?!<\/button>).)*<\/button>/)?.[0] ?? null;

describe("PreviewCard", () => {
  test("fresh preview: countdown, resolved numbers, notes, assumptions as HYP, enabled CONFIRM", () => {
    const at = Date.now();
    const html = render(preview({}, at), at);
    expect(html).toMatch(/VALID 1:00|VALID 0:59/);
    expect(html).toContain("0.8%");
    expect(html).toContain("RISK OF BOOK");
    expect(html).toContain("$78.90");
    expect(html).toContain("yesterday&#x27;s low 3,412.5 (2026-10-12 UTC candle)");
    expect(html).toContain("entry = market, resolved at mark 3,600.1");
    expect(html).toContain(">HYP<");
    expect(html).toContain("leverage defaulted to 3x");
    expect(html).toContain(">PASS<");
    expect(html).toContain(">PAPER<");
    const btn = confirmButton(html);
    expect(btn).not.toBeNull();
    expect(btn).not.toContain('disabled=""');
    expect(html).not.toContain(STALE_TEXT);
  });

  test("after expiry: stale strip, body at 70%, CONFIRM replaced by RE-PREVIEW", () => {
    const at = Date.now() - 61_000;
    const html = render(preview({}, at), at);
    expect(html).toContain(STALE_TEXT);
    expect(html).toContain("opacity-70");
    expect(html).toContain(">STALE<");
    expect(html).not.toContain("VALID ");
    expect(confirmButton(html)).toBeNull();
    expect(html).toContain("RE-PREVIEW");
  });

  test("a 409 message renders verbatim and disables confirming", () => {
    const at = Date.now();
    const msg = "mark moved from 3,600.1 to 3,640.0 since the preview (limit 0.5%): preview it again";
    const html = render(preview({}, at), at, { stale: msg });
    expect(html).toContain(msg);
    expect(confirmButton(html)).toBeNull();
  });

  test("rejected verdict disables CONFIRM with the reason line", () => {
    const at = Date.now();
    const p = preview({ verdict: { decision: "reject", approved: false, reasons: ["risk 2.0% exceeds the 1% cap"], warnings: [], equityUsd: 10_000, checkedAt: new Date(at).toISOString() } }, at);
    const html = render(p, at);
    expect(html).toContain(">REJECTED<");
    expect(html).toContain("risk 2.0% exceeds the 1% cap");
    expect(confirmButton(html)).toContain('disabled=""');
    expect(html).toContain("governor rejected — adjust and re-preview");
  });

  test("unknown venue disables CONFIRM", () => {
    const at = Date.now();
    const html = render(preview({}, at), at, { venue: null });
    expect(html).toContain("venue unknown — open DESK to check");
    expect(confirmButton(html)).toContain('disabled=""');
  });

  test("busy (a request in flight) disables CONFIRM", () => {
    const at = Date.now();
    const html = render(preview({}, at), at, { busy: true });
    expect(confirmButton(html)).toContain('disabled=""');
  });
});

describe("order gates", () => {
  test("countdown runs 60 s from receipt and never past the server expiry", () => {
    const at = 1_000_000;
    const exp = new Date(at + 60_000).toISOString();
    expect(previewRemainingMs(exp, at, at)).toBe(60_000);
    expect(previewRemainingMs(exp, at, at + 45_500)).toBe(14_500);
    expect(previewRemainingMs(exp, at, at + 61_000)).toBe(0);
    expect(previewRemainingMs(new Date(at + 30_000).toISOString(), at, at + 31_000)).toBe(0);
    expect(fmtCountdown(42_000)).toBe("0:42");
    expect(fmtCountdown(0)).toBe("0:00");
  });

  test("venue mapping and confirm block", () => {
    expect(venueOf("paper")).toBe("paper");
    expect(venueOf("hl-testnet")).toBe("testnet");
    expect(venueOf("mainnet")).toBeNull();
    const p = preview();
    expect(confirmBlock(p, "paper", null)).toBeNull();
    expect(confirmBlock(p, "testnet", null)).toBe("venue unknown — open DESK to check");
    expect(confirmBlock(p, null, "DESK_VENUE=mainnet is not supported")).toBe("DESK_VENUE=mainnet is not supported");
  });
});

describe("confirm single-flight", () => {
  test("a second click while the first request is pending does not send", async () => {
    const flight = createSingleFlight();
    let calls = 0;
    let release!: (v: string) => void;
    const send = () => {
      calls++;
      return new Promise<string>((r) => (release = r));
    };
    const first = flight.run(send);
    const second = flight.run(send);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(flight.busy).toBe(true);
    await Promise.resolve();
    expect(calls).toBe(1);
    release("ok");
    expect(await first).toBe("ok");
    expect(flight.busy).toBe(false);
    // the guard frees up only once the request settles, failures included
    const third = flight.run(() => Promise.reject(new Error("409")));
    expect(flight.run(send)).toBeNull();
    await expect(third).rejects.toThrow("409");
    expect(flight.busy).toBe(false);
    expect(calls).toBe(1);
  });
});
