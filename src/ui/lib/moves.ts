import { MoveDetailSchema, MovesResponseSchema, type MoveDetail, type MovesResponse, type MoveWindow } from '../../shared/moves'
import {
  AgentRecordSchema,
  AgentStatsResponseSchema,
  TriageResponseSchema,
  type AgentRecord,
  type AgentStatsResponse,
  type TriageResponse,
} from '../../shared/agentRecords'
import { api, parseWith } from './api'

// Typed /api/moves client (docs/SPEC.md § Moves). Every response is parsed with its src/shared schema, so a
// contract drift fails loudly as an ErrorBlock instead of rendering garbage. 401 → /login lives in api.ts.

const list = parseWith(MovesResponseSchema, 'moves')
const detail = parseWith(MoveDetailSchema, 'move detail')
const triage = parseWith(TriageResponseSchema, 'moves triage')
const record = parseWith(AgentRecordSchema, 'agent record')
const stats = parseWith(AgentStatsResponseSchema, 'agent stats')
const enc = encodeURIComponent

export const moves = {
  list: async (window: MoveWindow): Promise<MovesResponse> => list(await api.get(`/moves?window=${window}`)),
  detail: async (coin: string, window: MoveWindow): Promise<MoveDetail> => detail(await api.get(`/moves/${enc(coin)}?window=${window}`)),
  triage: async (): Promise<TriageResponse> => triage(await api.get('/moves/triage')),
  /** INVESTIGATE: one LLM run. 409 in flight, 429 cap reached, 503 no provider (see logic.investigateFailure). */
  investigate: async (coin: string): Promise<AgentRecord> => record(await api.post(`/moves/${enc(coin)}/investigate`)),
  stats: async (): Promise<AgentStatsResponse> => stats(await api.get('/moves/records/stats')),
}
