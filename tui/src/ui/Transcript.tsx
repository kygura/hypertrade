// Scrollback: every finished entry printed once through <Static>.
import { Box, Static } from "ink";
import type { Entry } from "../app/model.js";
import { BookSummaryLine } from "./Book.js";
import { AgentText, AlertLine, AlertsList, BannerLine, ErrorLine, NoteLine, ToolLine, UserLine } from "./lines.js";
import { PosSnapshot } from "./Positions.js";
import { BriefBlock, CoinCard, HelpList, ModelLine, PulseList } from "./Snapshots.js";
import { ResultBlock, TicketCard, TicketNote } from "./Ticket.js";

export interface EntryViewProps {
  entry: Entry;
  /** Full width (tables, cards). */
  width: number;
  /** Prose width (agent text, alerts, notes). */
  prose: number;
}

export function EntryView({ entry: e, width, prose }: EntryViewProps) {
  switch (e.kind) {
    case "banner":
      return <BannerLine info={e.info} />;
    case "user":
      return <UserLine text={e.text} />;
    case "agent-text":
      return <AgentText text={e.text} width={prose} {...(e.cont ? { cont: true } : {})} />;
    case "tool-line":
      return <ToolLine name={e.name} args={e.args} status={e.status} {...(e.ms != null ? { ms: e.ms } : {})} {...(e.error ? { error: e.error } : {})} />;
    case "alert":
      return <AlertLine alert={e.alert} width={prose} />;
    case "error":
      return <ErrorLine source={e.source} message={e.message} width={prose} {...(e.hint ? { hint: e.hint } : {})} />;
    case "note":
      return <NoteLine text={e.text} width={prose} />;
    case "ticket":
      return e.outcome === "discarded" || e.outcome === "dismissed" ? <TicketNote ticket={e.ticket} ui={e.ui} /> : <TicketCard ticket={e.ticket} ui={e.ui} width={width} at={e.at} />;
    case "result":
      return <ResultBlock result={e.result} demo={e.demo} outcome={e.outcome} />;
    case "view-snapshot":
      switch (e.view) {
        case "pos":
          return <PosSnapshot account={e.data.account} configured={e.data.configured} szDecimals={e.data.szDecimals} at={e.at} width={width} now={e.at} />;
        case "coin":
          return <CoinCard view={e.data} width={width} at={e.at} />;
        case "alerts":
          return <AlertsList alerts={e.data} now={e.at} at={e.at} width={prose} />;
        case "pulse":
          return <PulseList pulse={e.data} at={e.at} width={prose} />;
        case "brief":
          return <BriefBlock brief={e.data} now={e.at} width={prose} />;
        case "help":
          return <HelpList commands={e.data} width={width} />;
        case "model":
          return <ModelLine label={e.data.label} {...(e.data.reason ? { reason: e.data.reason } : {})} />;
        case "book-summary":
          return <BookSummaryLine book={e.data.book} szDecimals={e.data.szDecimals} at={e.at} />;
      }
  }
}

export function Transcript({ entries, width, prose }: { entries: Entry[]; width: number; prose: number }) {
  return (
    <Static items={entries}>
      {(e) => (
        <Box key={e.id} width={width} flexDirection="column">
          <EntryView entry={e} width={width} prose={prose} />
        </Box>
      )}
    </Static>
  );
}
