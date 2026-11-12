import { useCallback, useRef, useState } from 'react'
import { ConfirmDialog, EmptyBlock, HowToRead, Panel, PanelBody, PanelHeader, type Term } from '../../components'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { OrderBanner } from '../../components/intel/OrderBanner'
import { OrderComposer } from '../../components/intel/OrderComposer'
import { AdjustDisclosure } from '../../components/intel/AdjustDisclosure'
import { PreviewCard } from '../../components/intel/PreviewCard'
import { OrderResult } from '../../components/intel/OrderResult'
import {
  confirmBlock,
  confirmBody,
  createSingleFlight,
  EDITED_TEXT,
  placeLabel,
  previewRemainingMs,
  STALE_TEXT,
  VENUE_UNKNOWN,
  venueOf,
  type DeskVenue,
} from '../../components/intel/order'
import { api } from '../../lib/api'
import type { DeskStatus } from '../../lib/desk'
import { INTEL_POLL_MS, intel, isStalePreview, useIntel } from '../../lib/intel'
import { errorMessage } from '../../lib/poll'
import type { OrderConfirmResponse, OrderIntent, OrderPreview, OrderPreviewRequest } from '../../../shared/intel'

// `/order` — order copilot (DESIGN-terminal §7). Words → a governor-checked
// preview → the operator's explicit click inside the Level 2 ConfirmDialog →
// POST /order/confirm on the Desk venue (paper or testnet; mainnet refused
// server-side). Safety, enforced here:
// - the only caller of intel.confirmOrder is `place`, wired solely to the
//   dialog's confirm button; nothing confirms on Enter, on preview, or on a
//   timer;
// - `place` re-checks freshness at click time and runs through a single-flight
//   guard, so a double click never sends twice; the dialog's button is
//   disabled while the request is in flight;
// - success clears the preview; a 409 marks it stale (its hash is never sent
//   again) and only RE-PREVIEW is offered.

const ORDER_TERMS: Term[] = [
  ['PAPER / TESTNET', 'Where the order goes: the desk\'s simulated book, or the Hyperliquid test network. Mainnet is refused.'],
  ['3×', 'Leverage used for the liquidation estimate. It does not change the size; size comes from the amount you gave.'],
  ['RISK OF BOOK', 'Loss if the stop fills at its price, as a share of desk equity, with the USD amount beside it. Size times the distance from entry to stop, before fees and slippage.'],
  ['SIZE / NOTIONAL', 'Order size in coins, rounded down to the venue\'s size step, and its USD value at entry.'],
  ['ENTRY', 'MARKET ≈ is the venue mark at preview time; the fill can differ. LIMIT is the price you gave; the order is rejected when the mark is already past it.'],
  ['STOP', 'Stop price, how it was derived (as given, a percent, yesterday\'s low or high, or a multiple of the 14-day ATR on daily candles) and its distance from entry.'],
  ['EST. LIQUIDATION', 'Approximate liquidation price for an isolated position at that leverage, and its distance from entry. An estimate, not the venue\'s number.'],
  ['TARGET', 'Take-profit price, if you gave one. Without it the reward to risk check is skipped.'],
  ['GOVERNOR', 'The desk\'s fixed risk rules run on this order. PASS: within every limit. CLIPPED: allowed at a smaller size, stated beside the badge. REJECTED: not allowed, with the reasons; adjust and preview again.'],
  ['HOW IT RESOLVED', 'How each number was derived from your words and from market data.'],
  ['ASSUMED BY THE PARSER', 'Fields your text left out and the model filled with a default. HYP marks a line as the model\'s assumption, not an observed fact.'],
  ['VALID 0:42 / STALE', 'A preview can be confirmed for 60 seconds. After that, after an edit, or once the mark has moved more than 0.5%, it is stale and must be previewed again.'],
  ['ADJUST', 'Edit the resolved fields directly instead of rewriting the text. Any edit makes the preview stale.'],
]

interface Held {
  data: OrderPreview
  receivedAt: number
  parsedFrom?: string
}

export function Order() {
  const status = useIntel(() => api.get<DeskStatus>('/desk/status'), [], { intervalMs: INTEL_POLL_MS.deskStatus })
  const deskVenue: DeskVenue | null = status.data ? venueOf(status.data.venue) : null
  const venueError: string | null =
    status.error || status.offline
      ? VENUE_UNKNOWN
      : status.data && deskVenue == null
        ? status.data.venueNote || `${VENUE_UNKNOWN} (${status.data.venue})`
        : null

  const [text, setText] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [held, setHeld] = useState<Held | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [result, setResult] = useState<{ res: OrderConfirmResponse; venue: DeskVenue | null; asset: string; at: string } | null>(null)
  const [announce, setAnnounce] = useState('')
  const flight = useRef(createSingleFlight())

  /** `keep`: an earlier reason (a 409's verbatim message, an edit) wins over the expiry text. */
  const markStale = useCallback((msg: string, keep = false) => {
    setStale((s) => (keep && s != null ? s : msg))
    setDialog(false)
    setConfirmError(null)
    setAnnounce('preview stale')
  }, [])

  const runPreview = async (req: OrderPreviewRequest, parsedFrom?: string) => {
    if (previewing || confirming) return
    setPreviewing(true)
    setPreviewError(null)
    setDialog(false)
    try {
      const data = await intel.previewOrder(req)
      setHeld({ data, receivedAt: Date.now(), parsedFrom })
      setStale(null)
      setResult(null)
      setAnnounce('preview ready')
    } catch (err) {
      setPreviewError(errorMessage(err, 'preview failed'))
    } finally {
      setPreviewing(false)
    }
  }

  const onExpire = useCallback(() => markStale(STALE_TEXT, true), [markStale])
  const cancelDialog = useCallback(() => {
    if (!flight.current.busy) setDialog(false)
  }, [])
  const onDirty = useCallback(() => {
    setStale((s) => s ?? EDITED_TEXT)
    setDialog(false)
  }, [])

  /** The one path to POST /order/confirm: the dialog's confirm click. */
  const place = () => {
    if (!held || stale != null) return
    const { data, receivedAt } = held
    if (previewRemainingMs(data.expiresAt, receivedAt, Date.now()) <= 0) {
      markStale(STALE_TEXT)
      return
    }
    if (confirmBlock(data, deskVenue, venueError) != null) return
    const venueAtClick = deskVenue
    const p = flight.current.run(() => intel.confirmOrder(data.intent, data.previewHash))
    if (!p) return // already in flight
    setConfirming(true)
    setConfirmError(null)
    p.then(
      (res) => {
        setResult({ res, venue: venueAtClick, asset: data.intent.asset, at: new Date().toISOString() })
        setHeld(null)
        setStale(null)
        setDialog(false)
      },
      (err) => {
        if (isStalePreview(err)) {
          markStale(errorMessage(err, STALE_TEXT))
        } else {
          setConfirmError(errorMessage(err, 'confirm failed')) // dialog stays open, verbatim (DESIGN §7)
        }
      },
    ).finally(() => setConfirming(false))
  }

  const repreview = (intent?: OrderIntent) => {
    const i = intent ?? held?.data.intent
    if (i) void runPreview({ intent: i }, held?.parsedFrom)
  }

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col gap-3">
      <TerminalTabs />
      <OrderBanner venue={deskVenue} venueError={venueError} />
      <HowToRead terms={ORDER_TERMS}>
        Describe an order in words. The preview turns it into exact size, entry, stop and risk and runs the desk's risk rules on it. Check the risk of book and
        the governor line before confirming; nothing is placed until you confirm, and a preview is valid for 60 seconds.
      </HowToRead>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        <div className="lg:col-span-5">
          <Panel>
            <PanelHeader title="DESCRIBE" />
            <PanelBody className="p-3 flex flex-col gap-3">
              <OrderComposer text={text} onText={setText} onPreview={(t) => void runPreview({ text: t }, t)} previewing={previewing} error={previewError} />
              {held && <AdjustDisclosure intent={held.data.intent} onRepreview={repreview} onDirty={onDirty} busy={previewing} />}
            </PanelBody>
          </Panel>
        </div>
        <div className="lg:col-span-7">
          {result ? (
            <OrderResult result={result.res} venue={result.venue} asset={result.asset} placedAt={result.at} onNew={() => setResult(null)} />
          ) : held ? (
            <PreviewCard
              preview={held.data}
              venue={deskVenue}
              venueError={venueError}
              receivedAt={held.receivedAt}
              stale={stale}
              parsedFrom={held.parsedFrom}
              busy={previewing || confirming}
              onConfirm={() => {
                setConfirmError(null)
                setDialog(true)
              }}
              onRepreview={() => repreview()}
              onExpire={onExpire}
            />
          ) : (
            <Panel>
              <PanelHeader title="PREVIEW" />
              <PanelBody>
                <EmptyBlock label="No preview yet. Describe an order and press PREVIEW; its size, stop, risk and the governor's check appear here." />
              </PanelBody>
            </Panel>
          )}
        </div>
      </div>
      {dialog && held && stale == null && (
        <ConfirmDialog
          title={placeLabel(deskVenue)}
          body={confirmBody(held.data, deskVenue)}
          confirmLabel={placeLabel(deskVenue)}
          onConfirm={place}
          onCancel={cancelDialog}
          error={confirmError}
          busy={confirming}
        />
      )}
    </div>
  )
}
