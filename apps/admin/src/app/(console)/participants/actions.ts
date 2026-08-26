'use server'

import type { MaskedParticipant } from '@/lib/console-contract'
import { FIXTURE_CAMPAIGN_ID, getOperatorConsoleGateway } from '@/lib/console-gateway'
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

  const rawCursor = formData.get('cursor')
  const cursor = typeof rawCursor === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(rawCursor) ? rawCursor : undefined
  const result = await getOperatorConsoleGateway().searchParticipants({
    campaignId: FIXTURE_CAMPAIGN_ID,
    query,
    ...(cursor === undefined ? {} : { cursor }),
  })
  return {
    status: 'complete',
    items: result.items,
    nextCursor: result.nextCursor,
    reasonCode: null,
  }
}
