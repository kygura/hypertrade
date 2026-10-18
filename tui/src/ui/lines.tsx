// One-line-ish transcript renderers: banner, user, agent text, tool lines,
// errors, notes and alerts (DESIGN.md §3 entry kinds, §7).
import { Box, Text } from "ink";
import type { BannerInfo, ToolStatus } from "../app/model.js";
import type { Alert, AlertLevel } from "../core/types.js";
import { fmtAge, fmtClock, shortAddr } from "./format.js";
import { g, tone } from "./theme.js";

export const VERSION = "0.1";

export function BannerLine({ info }: { info: BannerInfo }) {
  const parts = info.demo
    ? [`ht ${VERSION}`, "DEMO", "fixtures, no network", info.account ? shortAddr(info.account) : "no account", "orders simulated"]
    : [`ht ${VERSION}`, info.network, info.account ? shortAddr(info.account) : "no account", info.canTrade ? "read-write" : "read-only"];
  parts.push(info.agentLabel ? `agent ${info.agentLabel}` : "agent off", "/help for commands");
  return <Text {...tone("dim")}>{parts.join(" · ")}</Text>;
}

export function UserLine({ text }: { text: string }) {
  return (
    <Text>
      <Text {...tone("accent")}>{g().prompt} </Text>
      <Text bold>{text}</Text>
    </Text>
  );
}

/** `**bold**` and `code` only; no colors inside model text other than accent for code. */
export function inlineSegments(text: string): Array<{ text: string; kind: "plain" | "bold" | "code" }> {
  const out: Array<{ text: string; kind: "plain" | "bold" | "code" }> = [];
  for (const part of text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push({ text: part.slice(2, -2), kind: "bold" });
    else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push({ text: part.slice(1, -1), kind: "code" });
    else out.push({ text: part, kind: "plain" });
  }
  return out;
}

/** `●` on the first paragraph of an answer, 2-space hanging indent; `cont` paragraphs get a blank line and no marker. */
export function AgentText({ text, width, cont = false }: { text: string; width: number; cont?: boolean }) {
  return (
    <Box flexDirection="row" {...(cont ? { marginTop: 1 } : {})}>
      <Box width={2} flexShrink={0}>
        <Text {...tone("accent")}>{cont ? " " : g().bullet}</Text>
      </Box>
      <Box width={Math.max(10, width - 2)}>
        <Text>
          {inlineSegments(text).map((s, i) => (
            <Text key={i} {...(s.kind === "bold" ? { bold: true } : s.kind === "code" ? tone("accent") : {})}>
              {s.text}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  );
}

export function ToolLine({ name, args, status, ms, error }: { name: string; args: string; status: ToolStatus; ms?: number; error?: string }) {
  const head = `  ${g().tool} ${name}${args ? ` ${args}` : ""}`;
  const tail = status === "running" ? ` · ${g().ellipsis}` : status === "aborted" ? " · aborted" : ms != null ? ` · ${ms}ms` : "";
  return (
    <Text wrap="truncate-end">
      <Text {...tone("dim")}>
        {head}
        {tail}
      </Text>
      {status === "error" && (
        <>
          <Text {...tone("dim")}> · </Text>
          <Text {...tone("critical")}>error</Text>
          <Text {...tone("dim")}>: {error ?? "failed"}</Text>
        </>
      )}
    </Text>
  );
}

export function ErrorLine({ source, message, hint, width }: { source: string; message: string; hint?: string; width: number }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={2} flexShrink={0}>
          <Text {...tone("critical")}>{g().cross}</Text>
        </Box>
        <Box width={Math.max(10, width - 2)}>
          <Text>
            {source}: {message}
          </Text>
        </Box>
      </Box>
      {hint && (
        <Box paddingLeft={2} width={width}>
          <Text {...tone("dim")}>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}

export function NoteLine({ text, width }: { text: string; width: number }) {
  return (
    <Box width={width}>
      <Text {...tone("dim")}>– {text}</Text>
    </Box>
  );
}

const LEVEL: Record<AlertLevel, { marker: string; tag: string }> = {
  info: { marker: "·", tag: "INFO" },
  warn: { marker: "!", tag: "WARN" },
  critical: { marker: "!!", tag: "CRIT" },
};

/** `! WARN  14:02:40  title · detail`, detail wrapping under the title. `age` replaces the clock (AlertsList). */
export function AlertLine({ alert, width, age }: { alert: Alert; width: number; age?: string }) {
  const l = LEVEL[alert.level];
  const markTone = alert.level === "info" ? "dim" : alert.level === "warn" ? "warn" : "critical";
  const prefix = `${`${l.marker} ${l.tag}`.padEnd(7)}  ${age ?? fmtClock(alert.at)}  `;
  const crit = alert.level === "critical";
  return (
    <Box>
      <Box width={prefix.length} flexShrink={0}>
        <Text {...tone(markTone)}>{prefix}</Text>
      </Box>
      <Box width={Math.max(10, width - prefix.length)}>
        <Text>
          <Text {...(crit ? tone("critical") : {})}>{alert.title}</Text>
          {alert.detail ? <Text {...(crit ? {} : tone("dim"))}> · {alert.detail}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
}

export function AlertsList({ alerts, now, at, width }: { alerts: Alert[]; now: number; at: number; width: number }) {
  return (
    <Box flexDirection="column">
      <Text {...tone("dim")}>
        ALERTS · {fmtClock(at)} · {alerts.length} active
      </Text>
      {alerts.length === 0 && <Text {...tone("dim")}>no active alerts</Text>}
      {[...alerts]
        .sort((a, b) => b.at - a.at)
        .map((a) => (
          <AlertLine key={a.key} alert={a} width={width} age={fmtAge(now - a.at).padStart(3)} />
        ))}
    </Box>
  );
}
