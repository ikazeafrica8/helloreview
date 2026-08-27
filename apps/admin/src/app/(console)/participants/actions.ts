'use server'

import type { MaskedParticipant } from '@/lib/console-contract'
import { FIXTURE_CAMPAIGN_ID } from '@/lib/console-gateway'
import { getOperatorConsoleGateway } from '@/lib/console-gateway-provider'
import { getOperatorConsoleSession, isOperatorConsoleAuthorized } from '@/lib/operator-session'

export type ParticipantSearchState = Readonly<{
  status: 'idle' | 'invalid' | 'denied' | 'complete'
  items: readonly MaskedParticipant[]
  nextCursor: string | null
  reasonCode: string | null
}>

const INVALID_STATE: ParticipantSearchState = {
  status: 'invalid',
  items: [],
  nextCursor: null,
  reasonCode: 'PARTICIPANT_SEARCH_QUERY_INVALID',
}

const INVALID_CURSOR_STATE: ParticipantSearchState = {
  status: 'invalid',
  items: [],
  nextCursor: null,
  reasonCode: 'ADMIN_CURSOR_INVALID',
}

export async function searchMaskedParticipants(
  _previousState: ParticipantSearchState,
  formData: FormData,
): Promise<ParticipantSearchState> {
  const session = getOperatorConsoleSession()
  if (session === null || !isOperatorConsoleAuthorized(session, 'participants.search', FIXTURE_CAMPAIGN_ID))
    return {
      status: 'denied',
      items: [],
      nextCursor: null,
      reasonCode: 'OPERATOR_PARTICIPANT_SEARCH_DENIED',
    }

  const rawQuery = formData.get('query')
  if (typeof rawQuery !== 'string') return INVALID_STATE
  const query = rawQuery.trim()
  if (query.length < 2 || query.length > 200) return INVALID_STATE

  const cursorFields = formData.getAll('cursor')
  if (cursorFields.length > 1) return INVALID_CURSOR_STATE
  const rawCursor = cursorFields[0]
  if (rawCursor !== undefined && (typeof rawCursor !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(rawCursor)))
    return INVALID_CURSOR_STATE
  const cursor = typeof rawCursor === 'string' ? rawCursor : undefined
  const result = await getOperatorConsoleGateway().searchParticipants(session, {
    campaignId: FIXTURE_CAMPAIGN_ID,
    query,
    ...(cursor === undefined ? {} : { cursor }),
  })
  if (result === null)
    return {
      status: 'denied',
      items: [],
      nextCursor: null,
      reasonCode: 'OPERATOR_PARTICIPANT_SEARCH_DENIED',
    }
  if (result.reasonCode !== null)
    return {
      status: 'invalid',
      items: [],
      nextCursor: null,
      reasonCode: result.reasonCode,
    }
  return {
    status: 'complete',
    items: result.items,
    nextCursor: result.nextCursor,
    reasonCode: null,
  }
}
