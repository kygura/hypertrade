import { useCallback, useRef, useState } from 'react'
import { ConfirmDialog, EmptyBlock, Panel, PanelBody, PanelHeader } from '../../components'
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
                <EmptyBlock label="describe an order to preview it" />
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
