import { useEffect, useState } from 'react'
import { fmtTimeLeft, fmtUntilUtc, globalLockLine, stopOutEntry, type ActiveLock, type DeskCooldownResponse } from '../../lib/deskPlan'

// CooldownNotice — what replaces the plan form while a stop-out lock holds
// (docs/design/desk-calm.md §3): when entries resume, as an absolute UTC time
// and a coarse "about 3h left" that changes at most once a minute, and the
// journal entry for the loss. There is no override.

/** Epoch ms, refreshed once a minute: enough for coarse "time left" text, never a ticking clock. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

type Locked = DeskCooldownResponse['coins'][number]

function Entry({ lock, now }: { lock: Locked; now: number }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className="text-xs text-text-secondary tabular">
        {lock.coin} stopped out at {fmtUntilUtc(lock.stopOutAt, now)}
      </span>
      <span className="text-sm text-text-muted break-words">{stopOutEntry(lock)}</span>
    </li>
  )
}

export function CooldownNotice({ lock, cooldown, now }: { lock: ActiveLock; cooldown: DeskCooldownResponse | null; now: number }) {
  if (lock.kind === 'all') {
    const entries = cooldown?.coins ?? []
    return (
      <div role="status" className="flex flex-col gap-2 border border-border-subtle p-3" data-testid="cooldown-notice">
        <p className="m-0 text-md text-text-primary">{globalLockLine(lock.until, cooldown?.stopOutsToday ?? 0)}</p>
        <span className="text-xs text-text-secondary tabular">{fmtTimeLeft(lock.until, now)}</span>
        {entries.length > 0 && (
          <ul className="m-0 p-0 list-none flex flex-col gap-2 border-t border-border-subtle pt-2">
            {entries.map((l) => (
              <Entry key={`${l.coin}-${l.stopOutAt}`} lock={l} now={now} />
            ))}
          </ul>
        )}
      </div>
    )
  }
  const l = lock.lock
  return (
    <div role="status" className="flex flex-col gap-2 border border-border-subtle p-3" data-testid="cooldown-notice">
      <p className="m-0 text-md text-text-primary">
        New {l.coin} entries are paused after a stop-out. They resume at {fmtUntilUtc(l.until, now)}.
      </p>
      <span className="text-xs text-text-secondary tabular">{fmtTimeLeft(l.until, now)}</span>
      <ul className="m-0 p-0 list-none border-t border-border-subtle pt-2">
        <Entry lock={l} now={now} />
      </ul>
    </div>
  )
}
