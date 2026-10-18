import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRepoRoot, loadBrief } from "./brief.js";

test("loadBrief reads the committed routine files from the real repo", async () => {
  const root = defaultRepoRoot();
  const brief = await loadBrief(root);
  expect(brief).not.toBeNull();
  const b = brief!;
  expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(b.headline.length).toBeGreaterThan(0);
  expect(b.tldr.length).toBeGreaterThan(0);
  expect(b.risks.length).toBeGreaterThan(0);
  expect(b.sectors.length).toBeLessThanOrEqual(5);
  const scores = b.sectors.map((s) => s.score);
  expect([...scores].sort((x, y) => y - x)).toEqual(scores);
});

test("loadBrief returns null when data/marketstate/latest.json is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tui-brief-"));
  try {
    expect(await loadBrief(dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadBrief takes top 5 sectors by mindshare and tolerates a missing sectors file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tui-brief-"));
  try {
    await mkdir(join(dir, "data", "marketstate"), { recursive: true });
    await mkdir(join(dir, "data", "sectors"), { recursive: true });
    const ms = {
      generated_at: "2026-10-18T05:00:00Z",
      headline: "H",
      tldr: "Regime: risk-off (33% BTC, since Oct 12). Main change: x.",
      domains: [],
      thesis: { observe: "o", infer: "i", forecast: "f", disclaimer: "d" },
      risks: ["Daily BTC close below $79.2K"],
    };
    await writeFile(join(dir, "data", "marketstate", "latest.json"), JSON.stringify(ms));

    const noSectors = await loadBrief(dir);
    expect(noSectors).toMatchObject({ date: "2026-10-18", headline: "H", regime: "risk-off", risks: ["Daily BTC close below $79.2K"], sectors: [] });

    const sector = (id: string, score: number) => ({ id, label: id.toUpperCase(), mindshare_score: score, momentum: 0, rationale: `r-${id}`, tokens: [], sources: [] });
    const sec = {
      generated_at: "2026-10-18T05:00:00Z",
      sectors: [sector("a", 0.1), sector("b", 0.9), sector("c", 0.5), sector("d", 0.3), sector("e", 0.7), sector("f", 0.2), sector("g", 0.6)],
      rotations: [],
    };
    await writeFile(join(dir, "data", "sectors", "latest.json"), JSON.stringify(sec));
    const withSectors = await loadBrief(dir);
    expect(withSectors?.sectors.map((s) => s.name)).toEqual(["B", "E", "G", "C", "D"]);
    expect(withSectors?.sectors[0]).toEqual({ name: "B", score: 0.9, note: "r-b" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
