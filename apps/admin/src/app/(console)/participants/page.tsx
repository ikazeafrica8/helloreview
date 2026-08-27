import type { Metadata } from 'next'
import { ConsoleAccessDenied } from '@/components/console-access-denied'
import { ParticipantSearchPanel } from '@/components/participant-search-panel'
import { ProductionBoundaryBanner } from '@/components/production-boundary-banner'
import { SessionRequired } from '@/components/session-required'
import { StatusBadge } from '@/components/status-badge'
import { FIXTURE_CAMPAIGN_ID } from '@/lib/console-gateway'
import { getOperatorConsoleSession, isOperatorConsoleAuthorized } from '@/lib/operator-session'

export const metadata: Metadata = { title: '참여자 검색' }

export default function ParticipantsPage() {
  const session = getOperatorConsoleSession()
  if (session === null) return <SessionRequired />
  if (!isOperatorConsoleAuthorized(session, 'participants.search', FIXTURE_CAMPAIGN_ID)) return <ConsoleAccessDenied />
  return (
    <main id="main-content" className="page-content" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">T112 · MASKED SEARCH</p>
          <h1>참여자 검색</h1>
          <p>캠페인 범위 안에서 마스킹된 식별자와 신청 상태, 블로거 근거를 분리해 확인합니다.</p>
        </div>
        <StatusBadge tone="safe">기본값 마스킹</StatusBadge>
      </div>
      <ProductionBoundaryBanner />
      <ParticipantSearchPanel campaignId={FIXTURE_CAMPAIGN_ID} />
    </main>
  )
}
