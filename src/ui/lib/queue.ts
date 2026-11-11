import { QueueDismissResponseSchema, QueueResponseSchema, type QueueDismissResponse, type QueueResponse } from '../../shared/queue'
import { api, parseWith } from './api'

// Typed /api/queue client (docs/SPEC.md § Queue). Parsed with the shared schema; 401 → /login lives in api.ts.

const list = parseWith(QueueResponseSchema, 'queue')
const dismissed = parseWith(QueueDismissResponseSchema, 'queue dismiss')

export const QUEUE_POLL_MS = 60_000

export const queue = {
  get: async (): Promise<QueueResponse> => list(await api.get('/queue')),
  /** DISMISS: hides the coin for the UTC day (and its triage item); it keeps its slot in the budget. */
  dismiss: async (id: string): Promise<QueueDismissResponse> => dismissed(await api.post(`/queue/${encodeURIComponent(id)}/dismiss`)),
}
