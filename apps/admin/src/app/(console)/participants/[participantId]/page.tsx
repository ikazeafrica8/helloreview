import type { Metadata } from 'next'
import Link from 'next/link'
import { ConsoleAccessDenied } from '@/components/console-access-denied'
import { ProductionBoundaryBanner } from '@/components/production-boundary-banner'
import { SessionRequired } from '@/components/session-required'
import { StatusBadge } from '@/components/status-badge'
import { getOperatorConsoleGateway } from '@/lib/console-gateway-provider'
import { getOperatorConsoleSession, isOperatorConsoleAuthorized } from '@/lib/operator-session'

type Props = Readonly<{
  params: Promise<{ participantId: string }>
  searchParams: Promise<{
    campaignId?: string | string[]
    cursor?: string | string[]
  }>
}>

const singleSearchParam = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { participantId } = await params
  return { title: `참여자 ${participantId.slice(0, 8)} 타임라인` }
}

const formatTimestamp = (value: string): string =>
  new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value))

export default async function ParticipantTimelinePage({ params, searchParams }: Props) {
  const [{ participantId }, rawSearchParams] = await Promise.all([params, searchParams])
  const campaignId = singleSearchParam(rawSearchParams.campaignId) ?? ''
  const cursor = Array.isArray(rawSearchParams.cursor)
    ? '__invalid-repeated-cursor__'
    : singleSearchParam(rawSearchParams.cursor)
  const session = getOperatorConsoleSession()
  if (session === null) return <SessionRequired />
  if (!isOperatorConsoleAuthorized(session, 'participants.timeline.read', campaignId)) return <ConsoleAccessDenied />
  const page = await getOperatorConsoleGateway().participantTimeline(session, {
    campaignId,
    participantId,
    ...(cursor === undefined ? {} : { cursor }),
  })
  if (page === null) return <ConsoleAccessDenied />
  const hasScope = page.participant !== null

  return (
    <main id="main-content" className="page-content" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">T112 · FULL PRD TIMELINE CONTRACT</p>
          <h1>참여자 타임라인</h1>
          <p>원시 페이로드 없이 PRD의 전체 이벤트 범주를 안정적인 시간·이벤트 ID 순서로 표시합니다.</p>
        </div>
        <StatusBadge tone={hasScope ? 'safe' : 'blocked'}>{hasScope ? '캠페인 범위 확인' : '범위 필요'}</StatusBadge>
      </div>
      <ProductionBoundaryBanner />
      {!hasScope ? (
        <section className="scope-boundary" role="alert">
          <p className="eyebrow">FAIL CLOSED</p>
          <h2>캠페인 범위가 없거나 일치하지 않습니다.</h2>
          <p>참여자 ID만으로는 타임라인을 조회하지 않습니다. 검색 결과에서 범위가 포함된 링크를 사용해 주세요.</p>
          <Link className="button-link" href="/participants">
            참여자 검색으로 돌아가기
          </Link>
        </section>
      ) : (
        <>
          <section className="timeline-context" aria-labelledby="timeline-context-title">
            <div>
              <p className="eyebrow">MASKED CONTEXT</p>
              <h2 id="timeline-context-title">
                {page.participant.maskedName} · {page.participant.maskedPhone}
              </h2>
            </div>
            <dl>
              <div>
                <dt>신청 상태</dt>
                <dd>{page.participant.applicationStatus}</dd>
              </div>
              <div>
                <dt>자동화</dt>
                <dd>{page.participant.automationState}</dd>
              </div>
              <div>
                <dt>소유권</dt>
                <dd>{page.participant.ownershipState}</dd>
              </div>
            </dl>
          </section>
          <section className="coverage-notice" aria-labelledby="coverage-title">
            <h2 id="coverage-title">타임라인 범위</h2>
            <p>
              이 결정론 fixture는 모든 §20.3 범주의 화면 계약을 검증합니다. 실제 어댑터는 구현된 영속 이벤트만 반환하고,
              별도 영속 모델이 아직 없는 AI/OCR 원문을 생성하거나 추정하지 않으며, 누락 범주는 명시적 미지원 상태로
              보고해야 합니다.
            </p>
            <ul className="coverage-grid" aria-label="PRD 타임라인 범주">
              {page.categorySupport.map((support) => (
                <li key={support.category}>
                  {support.category} ·{' '}
                  {support.status === 'available' ? '제공' : `미지원 (${support.reasonCode ?? 'UNKNOWN'})`}
                </li>
              ))}
            </ul>
          </section>
          {page.events.reasonCode === 'ADMIN_CURSOR_INVALID' ? (
            <section className="scope-boundary" role="alert">
              <p className="eyebrow">FAIL CLOSED</p>
              <h2>유효하지 않은 타임라인 커서입니다.</h2>
              <p>검색 결과에서 제공된 페이지 링크를 다시 사용해 주세요.</p>
              <code>ADMIN_CURSOR_INVALID</code>
            </section>
          ) : (
            <>
              <ol className="timeline-list">
                {page.events.items.map((event) => (
                  <li key={event.eventId}>
                    <div className="timeline-marker" aria-hidden="true" />
                    <article>
                      <div className="timeline-heading">
                        <div>
                          <p className="eyebrow">{event.category}</p>
                          <h2>{event.eventCode}</h2>
                        </div>
                        <time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time>
                      </div>
                      <dl>
                        <div>
                          <dt>상태 코드</dt>
                          <dd>{event.stateCode ?? '—'}</dd>
                        </div>
                        <div>
                          <dt>사유 코드</dt>
                          <dd>{event.reasonCode ?? '—'}</dd>
                        </div>
                        <div>
                          <dt>버전</dt>
                          <dd>{event.version === null ? '—' : `v${event.version}`}</dd>
                        </div>
                      </dl>
                    </article>
                  </li>
                ))}
              </ol>
              {page.events.nextCursor === null ? null : (
                <Link
                  className="button-link pagination-link"
                  href={`/participants/${participantId}?campaignId=${encodeURIComponent(campaignId)}&cursor=${encodeURIComponent(page.events.nextCursor)}`}
                >
                  이전 이벤트 더 보기
                </Link>
              )}
            </>
          )}
        </>
      )}
    </main>
  )
}
