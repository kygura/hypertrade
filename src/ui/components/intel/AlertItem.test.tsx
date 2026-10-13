import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Alert } from "../../../shared/intel";
import { AlertItem, castVote, kindWord, pricedInText } from "./AlertItem";

// castVote is the optimistic-with-rollback core of AlertItem's feedback
// (DESIGN-terminal §3.5); markup is render-checked like Segmented.test.tsx.

const alert: Alert = {
  id: "a1",
  kind: "mapper",
  ref: "c1",
  window: null,
  asset: "SOL",
  title: "Jito exploit",
  eventType: "exploit",
  line: { tag: "hypothesis", text: "Long SOL. The exploit is on Jito, which affects LST collateral." },
  path: [{ from: "Jito", to: "SOL", type: "collateral" }],
  edgeType: "collateral",
  hops: 1,
  pathWeight: 0.8,
  sources: [{ label: "The Block", url: "https://www.theblock.co/x" }],
  materiality: 0.62,
  pricedIn: { pricePct: -4.1, oiPct: -8, since: "2026-10-13T10:00:00.000Z" },
  route: "push",
  feedback: null,
  createdAt: new Date(Date.now() - 14 * 60_000).toISOString(),
};

describe("castVote", () => {
  test("optimistic set, kept on success", async () => {
    const seen: Alert["feedback"][] = [];
    const err = await castVote(null, 1, async () => {}, (v) => seen.push(v));
    expect(err).toBeNull();
    expect(seen).toEqual([1]);
  });

  test("rolls back to the previous vote and returns the verbatim error", async () => {
    const seen: Alert["feedback"][] = [];
    const err = await castVote(-1, 1, () => Promise.reject(new Error("alert not found")), (v) => seen.push(v));
    expect(seen).toEqual([1, -1]);
    expect(err).toBe("alert not found");
  });
});

describe("AlertItem", () => {
  const render = (a: Alert) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <AlertItem alert={a} onVote={async () => {}} pushMateriality={0.35} />
      </MemoryRouter>,
    );

  test("article label, PUSHED, amber materiality, priced-in suffix, path", () => {
    const html = render(alert);
    expect(html).toContain('aria-label="Alert: SOL, materiality 0.62"');
    expect(html).toContain(">PUSHED<");
    expect(html).toContain("text-amber");
    expect(html).toContain("· already −4.1%, OI −8%");
    expect(html).toContain("→COLLATERAL→");
  });

  test("feedback buttons are labelled words with aria-pressed from the stored vote", () => {
    const html = render({ ...alert, feedback: 1, route: "batch" });
    expect(html).toContain(">BATCHED<");
    expect(html).toMatch(/aria-label="mark alert useful" aria-pressed="true"/);
    expect(html).toMatch(/aria-label="mark alert as noise" aria-pressed="false"/);
    expect(html).toContain("✓ USEFUL");
    expect(html).not.toContain("✓ NOISE");
  });

  test("kind words and priced-in without OI history", () => {
    expect(kindWord({ kind: "mapper", window: null })).toBeNull();
    expect(kindWord({ kind: "catalyst", window: "24h" })).toBe("CATALYST T−24H");
    expect(kindWord({ kind: "docwatch", window: null })).toBe("WATCH CHANGE");
    expect(pricedInText({ pricePct: 2, oiPct: null, since: alert.createdAt })).toBe("· already +2.0%");
    expect(pricedInText(null)).toBeNull();
  });
});
