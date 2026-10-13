import type { ExposurePosition, PositionsResponse, Side } from "../../../shared/intel.js";
import type { Alert as DeskAlert, Notifier } from "../../desk/notify.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { MapperDeps } from "../mapper.js";
import { MemoryIntelStore } from "../store.js";
import { llmDeps } from "./emit-provider.js";

// Test support for mapper / catalysts / ingest-cycle tests: positions,
// a recording notifier and MapperDeps over a MemoryIntelStore.

export function position(asset: string, side: Side, notionalUsd: number, extra: Partial<ExposurePosition> = {}): ExposurePosition {
  const px = extra.markPx ?? 100;
  return {
    id: `manual-${asset}`,
    source: "manual",
    asset,
    side,
    size: notionalUsd / px,
    entryPx: px,
    markPx: px,
    stopPx: null,
    leverage: 1,
    venue: "manual",
    notionalUsd,
    unrealizedPnl: 0,
    ...extra,
  };
}

export function exposureOf(positions: ExposurePosition[]): PositionsResponse {
  return { positions, sources: [{ source: "manual", ok: true }], totalNotionalUsd: positions.reduce((s, p) => s + Math.abs(p.notionalUsd), 0) };
}

export class RecordingNotifier implements Notifier {
  readonly channels = ["test"];
  sent: DeskAlert[] = [];
  async send(a: DeskAlert) {
    this.sent.push(a);
    return ["test"];
  }
}

export function mapperDeps(o: {
  provider: LLMProvider | null;
  positions?: ExposurePosition[];
  watched?: string[];
  clock?: { now: Date };
  store?: MemoryIntelStore;
  pushMateriality?: number;
}): MapperDeps & { store: MemoryIntelStore; notifier: RecordingNotifier } {
  const clock = o.clock ?? { now: new Date("2026-10-13T12:00:00Z") };
  const now = () => clock.now;
  const store = o.store ?? new MemoryIntelStore(now);
  return {
    store,
    llm: llmDeps(o.provider, store, now),
    exposure: async () => exposureOf(o.positions ?? []),
    watched: async () => o.watched ?? [],
    candles1h: async () => [],
    notifier: new RecordingNotifier(),
    pushMateriality: o.pushMateriality ?? 0.35,
    appUrl: "https://app.example.com/",
    now,
  };
}
