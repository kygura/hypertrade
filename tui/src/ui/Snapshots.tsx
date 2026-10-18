// Inline snapshot views: /coin, /pulse, /brief, /help, /model. Each header names the clock time.
import { Box, Text } from "ink";
import type { HelpItem } from "../app/model.js";
import type { Brief } from "../core/brief.js";
import type { Pulse } from "../core/lab.js";
import type { CoinView } from "../core/types.js";
import { aprOf, fmtAge, fmtApr, fmtClock, fmtFundingH, fmtPct, fmtPx, fmtUsdCompact, MISSING, padEnd } from "./format.js";
import { PositionsTable } from "./Positions.js";
import { SegLine, type Line } from "./segs.js";
import { g, signTone, tone } from "./theme.js";

const LABEL_W = 10;
const label = (s: string) => ({ text: padEnd(s, LABEL_W), tone: "dim" as const });

export function CoinCard({ view, width, at }: { view: CoinView; width: number; at: number }) {
  const m = view.market;
  const px = m.midPx ?? m.markPx;
  const rows: Line[] = [
    [
      label("funding"),
      { text: `${fmtFundingH(m.fundingHourly)}/h`, tone: signTone(m.fundingHourly) },
      { text: "  APR ", tone: "dim" },
      { text: fmtApr(m.fundingAprPct), tone: signTone(m.fundingAprPct) },
      { text: "  pred ", tone: "dim" },
      m.predictedFundingHourly == null ? { text: MISSING } : { text: fmtApr(aprOf(m.predictedFundingHourly)), tone: signTone(m.predictedFundingHourly) },
    ],
    [label("OI"), { text: fmtUsdCompact(m.oiUsd) }, ...(m.atOiCap ? [{ text: "  at OI cap", tone: "warn" as const }] : [])],
    [label("24h vol"), { text: fmtUsdCompact(m.dayVolumeUsd) }],
    [label("premium"), m.premium == null ? { text: MISSING } : { text: fmtPct(m.premium * 100), tone: signTone(m.premium) }],
    view.atr14 == null
      ? [label("ATR14"), { text: MISSING }, { text: "  candles unavailable", tone: "dim" }]
      : [label("ATR14"), { text: fmtPx(view.atr14, m.szDecimals, px) }, { text: ` (${((view.atr14 / px) * 100).toFixed(1)}% of mark)`, tone: "dim" }],
    [label("regime"), { text: view.regime ?? MISSING }],
  ];
  return (
    <Box flexDirection="column">
      <SegLine
        line={[
          { text: `${m.coin}  `, bold: true },
          { text: `${fmtPx(px, m.szDecimals)}  ` },
          { text: fmtPct(m.dayChangePct), tone: signTone(m.dayChangePct) },
          { text: `  24h · ${fmtClock(at)}`, tone: "dim" },
        ]}
      />
      {rows.map((l, i) => (
        <SegLine key={i} line={l} />
      ))}
      {view.diagnostics.map((d, i) => (
        <Box key={`d${i}`} width={width}>
          <Text {...tone("dim")}>· {d}</Text>
        </Box>
      ))}
      {view.position ? <PositionsTable positions={[view.position]} width={width} szDecimals={{ [m.coin]: m.szDecimals }} /> : <Text {...tone("dim")}>no position</Text>}
    </Box>
  );
}

export function PulseList({ pulse, at, width }: { pulse: Pulse; at: number; width: number }) {
  return (
    <Box flexDirection="column">
      <Text {...tone("dim")}>
        LAB PULSE · as of {pulse.asOf} · {fmtClock(at)}
      </Text>
      {pulse.assets.length === 0 && <Text {...tone("dim")}>no catalogued rules</Text>}
      {pulse.assets.map((a) => (
        <Box key={a.asset} flexDirection="column">
          <SegLine
            line={[
              { text: padEnd(a.asset, 8), bold: true },
              { text: `long ${a.longActive}/${a.longTotal}  `, ...(a.longActive ? { tone: "up" as const } : { tone: "dim" as const }) },
              { text: `short ${a.shortActive}/${a.shortTotal}  `, ...(a.shortActive ? { tone: "down" as const } : { tone: "dim" as const }) },
              { text: `lean ${a.lean >= 0 ? "+" : ""}${a.lean.toFixed(2)}`, tone: "dim" },
            ]}
          />
          {a.rules
            .filter((r) => r.firing)
            .map((r) => (
              <Box key={r.id} width={width} paddingLeft={2}>
                <Text>
                  <Text {...tone("dim")}>{g().tool} </Text>
                  {r.name} <Text {...tone(r.direction === "long" ? "up" : "down")}>({r.direction.toUpperCase()})</Text>
                  <Text {...tone("dim")}>: {r.text}</Text>
                </Text>
              </Box>
            ))}
        </Box>
      ))}
      {pulse.warnings.map((w, i) => (
        <Text key={`w${i}`} {...tone("warn")}>
          ! {w}
        </Text>
      ))}
    </Box>
  );
}

/** Brief age from its YYYY-MM-DD date (start of that UTC day); warn past 36 h. */
export function BriefBlock({ brief, now, width }: { brief: Brief; now: number; width: number }) {
  const t = Date.parse(`${brief.date}T00:00:00Z`);
  const age = Number.isFinite(t) ? now - t : null;
  return (
    <Box flexDirection="column" width={width}>
      <SegLine
        line={[
          { text: `BRIEF ${brief.date}`, tone: "dim" },
          ...(brief.regime ? [{ text: ` · regime ${brief.regime}`, tone: "dim" as const }] : []),
          age == null ? { text: "" } : { text: ` · ${fmtAge(age)} old`, tone: age > 36 * 3_600_000 ? "warn" : "dim" },
        ]}
      />
      <Text bold>{brief.headline}</Text>
      <Text>{brief.tldr}</Text>
      {brief.risks.map((r, i) => (
        <Text key={`r${i}`}>· {r}</Text>
      ))}
      {brief.sectors.length > 0 && <Text {...tone("dim")}>TOP SECTORS</Text>}
      {brief.sectors.map((s) => (
        <Text key={s.name} wrap="truncate-end">
          {padEnd(s.name, 22)} {s.score.toFixed(2)} <Text {...tone("dim")}>{s.note}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function HelpList({ commands, width }: { commands: HelpItem[]; width: number }) {
  const w = Math.min(Math.max(...commands.map((c) => c.usage.length)) + 2, Math.max(20, width - 30));
  return (
    <Box flexDirection="column">
      {commands.map((c) => (
        <Box key={c.usage} width={width}>
          <Box width={w} flexShrink={0}>
            <Text {...tone("accent")}>{c.usage}</Text>
          </Box>
          <Text {...tone("dim")}>{c.summary}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ModelLine({ label: l, reason }: { label: string | null; reason?: string }) {
  return l ? <Text>model {l}</Text> : <Text {...tone("dim")}>agent off{reason ? ` — ${reason}` : ""}</Text>;
}
