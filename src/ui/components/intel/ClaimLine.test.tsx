import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Claim } from "../../../shared/claims";
import { ClaimLine } from "./ClaimLine";
import { ClaimList } from "./ClaimList";
import { sourceHref } from "./SourceLink";

// Render-check (react-dom/server, no jsdom), same approach as
// Segmented.test.tsx: DESIGN-terminal §2 markup and ARIA only.

const ts = new Date(Date.now() - 12 * 60_000).toISOString();
const obs: Claim = { tag: "observed", text: "HYPE open interest +18.4% in 6 h (z +3.1).", source: { label: "snapshot", url: "/markets/HYPE" }, ts };
const hyp: Claim = { tag: "hypothesis", text: "Leverage is building into the unlock; a flush is plausible." };
const ext: Claim = { tag: "observed", text: "Jito paused withdrawals.", source: { label: "The Block", url: "https://www.theblock.co/x" }, ts };

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe("ClaimLine", () => {
  test("observed: gray OBS badge, primary text, source + age, hidden prefix", () => {
    const html = render(<ClaimLine claim={obs} />);
    expect(html).toContain('data-claim="observed"');
    expect(html).toContain("badge--gray");
    expect(html).toContain(">OBS<");
    expect(html).not.toContain(">HYP<");
    expect(html).toContain('<span class="sr-only">observed:</span>');
    expect(html).toContain("text-text-primary");
    expect(html).toContain(obs.text); // verbatim, not uppercased
    // snapshot source → SNAP tag linked to the market drill, age 12M
    expect(html).toContain(">SNAP<");
    expect(html).toContain('href="/markets/HYPE"');
    expect(html).toMatch(/>12M</);
    expect(html).toContain('title="observed: snapshot, ');
  });

  test("hypothesis: info HYP badge, muted text with the info rule, no source slot", () => {
    const html = render(<ClaimLine claim={hyp} />);
    expect(html).toContain('data-claim="hypothesis"');
    expect(html).toContain("badge--info");
    expect(html).toContain(">HYP<");
    expect(html).not.toContain(">OBS<");
    expect(html).toContain('<span class="sr-only">hypothesis, model inference:</span>');
    expect(html).toContain('title="inference by the model — not an observed fact"');
    expect(html).toContain("text-text-muted");
    expect(html).toContain("var(--color-info)");
    expect(html).toContain(hyp.text);
    expect(html).not.toContain("src-tag");
    expect(html).not.toContain("<a ");
  });

  test("external source opens in a new tab with ↗ and hidden notice", () => {
    const html = render(<ClaimLine claim={ext} />);
    expect(html).toContain('href="https://www.theblock.co/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("↗");
    expect(html).toContain("(opens in a new tab)");
  });

  test("standalone renders a div; ClaimList renders li items", () => {
    expect(render(<ClaimLine claim={hyp} />)).toMatch(/^<div/);
    const html = render(<ClaimList claims={[obs, hyp]} />);
    expect(html).toContain("<ol");
    expect(html.match(/<li /g) ?? []).toHaveLength(2);
    // server order kept
    expect(html.indexOf(">OBS<")).toBeLessThan(html.indexOf(">HYP<"));
  });
});

describe("ClaimList dropped footer", () => {
  test("shown only when the trace reports dropped lines", () => {
    expect(render(<ClaimList claims={[obs]} />)).not.toContain("dropped");
    expect(render(<ClaimList claims={[obs]} dropped={0} />)).not.toContain("dropped");
    expect(render(<ClaimList claims={[obs]} dropped={2} />)).toContain("2 lines dropped — no source or tag");
    expect(render(<ClaimList claims={[]} dropped={1} />)).toContain("1 line dropped — no source or tag");
  });
});

describe("sourceHref", () => {
  test("only same-origin paths and http(s) URLs become links", () => {
    expect(sourceHref("/markets/SOL")).toEqual({ kind: "internal", href: "/markets/SOL" });
    expect(sourceHref("https://x.y/z")).toEqual({ kind: "external", href: "https://x.y/z" });
    expect(sourceHref("javascript:alert(1)")).toBeNull();
    expect(sourceHref("//evil.example/x")).toBeNull();
    expect(sourceHref(undefined)).toBeNull();
  });
});
