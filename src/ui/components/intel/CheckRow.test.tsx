import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ThesisClaim } from "../../../shared/intel";
import { CheckRow, fmtCheck, sortChecks } from "./CheckRow";

// CheckRow (DESIGN-terminal §5.2): status is a word on a toned Badge, the
// check is typeset in our language, evidence = value · source · age.

const ts = new Date(Date.now() - 12 * 60_000).toISOString();
const render = (c: ThesisClaim) => renderToStaticMarkup(<MemoryRouter><ol><CheckRow check={c} /></ol></MemoryRouter>);

const contradicted: ThesisClaim = {
  kind: "claim",
  text: "OI keeps rising",
  check: { kind: "oi_change", asset: "HYPE", window_h: 24, op: ">", pct: 5 },
  status: "contradicted",
  evidence: { value: -3.2, source: { label: "snapshot", url: "/markets/HYPE" }, ts },
};
const supported: ThesisClaim = {
  kind: "assumption",
  text: "BTC holds the level",
  check: { kind: "price_vs_level", asset: "BTC", op: ">", level: 79200 },
  status: "supported",
  evidence: { value: 81400, source: { label: "snapshot", url: "/markets/BTC" }, ts },
};
const unknown: ThesisClaim = { kind: "claim", text: "Unlock recipients hold", check: { kind: "unknown", reason: "not measurable" }, status: "unknown" };

describe("CheckRow", () => {
  test("contradicted: red CONTRADICTED badge, kind word, check and evidence", () => {
    const html = render(contradicted);
    expect(html).toContain("badge--red");
    expect(html).toContain(">CONTRADICTED<");
    expect(html).toContain(">CLAIM<");
    expect(html).toContain("OI keeps rising");
    expect(html).toContain("HYPE OI change 24h &gt; +5%");
    expect(html).toContain("now −3.2%");
    expect(html).toContain(">SNAP<");
    expect(html).toMatch(/>12M</);
  });

  test("supported: green SUPPORTED badge, ASSUMPTION, price typeset compactly", () => {
    const html = render(supported);
    expect(html).toContain("badge--green");
    expect(html).toContain(">SUPPORTED<");
    expect(html).toContain(">ASSUMPTION<");
    expect(html).toContain("BTC price &gt; $79.2K");
    expect(html).toContain("now $81.4K");
  });

  test("unknown with no data: gray UNKNOWN, no automatic check, no data", () => {
    const html = render(unknown);
    expect(html).toContain("badge--gray");
    expect(html).toContain(">UNKNOWN<");
    expect(html).toContain("no automatic check");
    expect(html).toContain("no data");
    expect(html).not.toContain("src-tag");
  });

  test("other checks typeset in our language", () => {
    expect(fmtCheck({ kind: "funding_sign", asset: "BTC", sign: "positive" })).toBe("BTC funding positive");
    expect(fmtCheck({ kind: "metric_threshold", series: "fred.DGS10", op: ">=", value: 4.5 })).toBe("metric fred.DGS10 ≥ 4.5");
    expect(fmtCheck({ kind: "event_exists", query: "HYPE unlock", since_h: 48 })).toBe('event since 48h: "HYPE unlock"');
  });

  test("sort: contradicted, then unknown, then supported", () => {
    expect(sortChecks([supported, unknown, contradicted]).map((c) => c.status)).toEqual(["contradicted", "unknown", "supported"]);
  });
});
