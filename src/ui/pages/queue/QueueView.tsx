import { AsyncBody, Badge, Button, PageContainer, Panel, PanelHeader, StatusDot } from '../../components'
import type { QueueItem, QueueResponse } from '../../../shared/queue'
import { CoinDecision } from '../coin/CoinDecision'
import type { Feed } from '../moves/MovesView'
import { agentLine, ageText, directionOf, emptyLine, headerLine, partsLabel, recordChip, sourceChips, sourceProblemLine, splitItems } from './logic'

// QUEUE view (PLAN2 §2.1/§2.2). Presentational: Queue.tsx owns the poll, the URL selection, the keyboard and
// DISMISS. The list is the page: a header line, the source chips (a source problem is one quiet line), the new
// items, then the collapsed dismissed / acted group. Desktop adds the coin's decision pane on the right. Nothing
// here approves, investigates on its own or places an order.

export interface QueueViewProps {
  queue: Feed<QueueResponse>
  /** Coins the moves scan watches (for the empty line); null when unknown. */
  watched: number | null
  selected: string | null
  /** Row click: desktop selects (pane), phone opens the coin page. */
  onRow: (coin: string) => void
  onDismiss: (id: string) => void
  /** Ids with a dismissal in flight, and the last failure. */
  pending: readonly string[]
  error: { id: string; message: string } | null
  handledOpen: boolean
  onHandled: (open: boolean) => void
  /** Desktop: the right pane shows the selected coin. */
  pane: boolean
  now: number
}

export function QueueView(p: QueueViewProps) {
  const q = p.queue.data
  const item = q?.items.find((i) => i.coin === p.selected) ?? null
  const showPane = p.pane && p.selected != null
  return (
    <PageContainer className="pb-3 md:pb-[var(--gutter)] min-w-0">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 min-w-0 items-start">
        <section aria-label="queue" className={`${showPane ? 'lg:col-span-4' : 'lg:col-span-12'} min-w-0`}>
          <Panel>
            <PanelHeader title={q ? headerLine(q) : 'QUEUE'} />
            <AsyncBody loading={p.queue.loading} data={q} error={p.queue.error} offline={p.queue.offline} onRetry={p.queue.refetch} rows={4}>
              {(d) => <QueueList {...p} q={d} />}
            </AsyncBody>
          </Panel>
        </section>
        {showPane && (
          <section aria-label="selected coin" className="lg:col-span-8 min-w-0">
            <CoinDecision key={p.selected} coin={p.selected!} item={item} blocked={q?.agentBlockedReason ?? null} layout="pane" />
          </section>
        )}
      </div>
    </PageContainer>
  )
}

export function QueueList(p: QueueViewProps & { q: QueueResponse }) {
  const { open, handled } = splitItems(p.q.items)
  const problem = sourceProblemLine(p.q)
  return (
    <div data-queue className="flex flex-col min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-border-subtle text-xs text-text-secondary">
        {sourceChips(p.q).map((c) => (
          <span key={c.source} className="inline-flex items-center gap-1 tabular" title={c.title} data-source={c.source} data-state={c.ok ? 'ok' : 'off'}>
            <StatusDot status={c.ok ? 'ok' : 'unknown'} />
            {c.label}
            {c.ok && ` ${c.count}`}
          </span>
        ))}
        <span className="tabular">{agentLine(p.q)}</span>
      </div>
      {problem && <p className="px-3 py-1 text-xs text-text-secondary break-words">{problem}</p>}
      {open.length === 0 && handled.length === 0 ? (
        <p className="px-3 py-3 text-sm text-text-secondary">{emptyLine(p.watched)}</p>
      ) : (
        <>
          {open.length === 0 && <p className="px-3 py-3 text-sm text-text-secondary">nothing new · every item today is handled</p>}
          <ul>
            {open.map((i) => (
              <QueueRow key={i.id} i={i} {...p} />
            ))}
          </ul>
          {handled.length > 0 && (
            <>
              <button
                type="button"
                className="text-left px-3 py-2 min-h-[var(--tap-min)] text-xs text-text-secondary hover:text-text-primary"
                aria-expanded={p.handledOpen}
                onClick={() => p.onHandled(!p.handledOpen)}
              >
                {p.handledOpen ? '▾' : '▸'} dismissed / acted ({handled.length})
              </button>
              {p.handledOpen && (
                <ul>
                  {handled.map((i) => (
                    <QueueRow key={i.id} i={i} {...p} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

export function QueueRow({ i, ...p }: QueueViewProps & { i: QueueItem }) {
  const chip = recordChip(i.record)
  const selected = p.selected === i.coin
  const busy = p.pending.includes(i.id)
  return (
    <li data-coin={i.coin} data-state={i.state} aria-selected={selected} className={`flex items-start gap-2 px-3 py-2 border-b border-border-subtle min-w-0 ${selected ? 'bg-selected' : ''}`}>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <button type="button" data-row className="min-w-0 text-left flex flex-col gap-0.5 min-h-[var(--tap-min)]" onClick={() => p.onRow(i.coin)}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={`text-sm font-semibold ${i.state === 'new' ? 'text-text-primary' : 'text-text-secondary'}`}>{i.coin}</span>
            <span className="text-xs text-text-secondary">{partsLabel(i)}</span>
            <span className="text-xs text-text-secondary">{directionOf(i)}</span>
            <span className="text-xs tabular text-text-secondary" title={`in the queue since ${i.firstAt}`}>
              {ageText(i.firstAt, p.now)}
            </span>
            {i.state !== 'new' && <Badge tone="gray">{i.state}</Badge>}
            {chip && <Badge tone={chip.tone}>{chip.label}</Badge>}
          </span>
          <span className="text-sm text-text-secondary break-words">{i.reason}</span>
        </button>
        {p.error?.id === i.id && (
          <p role="alert" className="text-xs text-red-text">
            {p.error.message}
          </p>
        )}
      </div>
      {i.state === 'new' && (
        <Button tier="ghost" className="min-h-[var(--tap-min)] shrink-0" disabled={busy} title="hide for today; it keeps its slot in the day's budget" onClick={() => p.onDismiss(i.id)}>
          DISMISS
        </Button>
      )}
    </li>
  )
}
