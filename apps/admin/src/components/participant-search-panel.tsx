'use client'

import Link from 'next/link'
import { useActionState, useId, useState } from 'react'
import { searchMaskedParticipants, type ParticipantSearchState } from '@/app/(console)/participants/actions'
import { StatusBadge } from './status-badge'

const INITIAL_STATE: ParticipantSearchState = {
  status: 'idle',
  items: [],
  nextCursor: null,
  reasonCode: null,
}

export function ParticipantSearchPanel({ campaignId }: Readonly<{ campaignId: string }>) {
  const [query, setQuery] = useState('')
  const [state, formAction, pending] = useActionState(searchMaskedParticipants, INITIAL_STATE)
  const formId = useId()

  return (
    <>
      <form id={formId} className="search-panel" role="search" action={formAction}>
        <div>
          <label htmlFor={`${formId}-query`}>검색어</label>
          <input
            id={`${formId}-query`}
            name="query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            minLength={2}
            maxLength={200}
            placeholder="가명, 마스킹 전화 끝자리, 참여자 ID"
            autoComplete="off"
            required
          />
        </div>
        <div>
          <span className="field-label">캠페인 범위</span>
          <code>{campaignId}</code>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? '검색 중…' : '마스킹 검색'}
        </button>
      </form>

      {state.status === 'idle' || state.status === 'invalid' || state.status === 'denied' ? (
        <div className="empty-state" role="status">
          <strong>
            {state.status === 'denied'
              ? '승인된 운영자 세션과 캠페인 범위가 필요합니다.'
              : '두 글자 이상의 검색어를 입력해 주세요.'}
          </strong>
          <span>
            검색은 POST 요청으로 처리되어 URL 기록에 남지 않습니다. 실제 이름이나 전체 전화번호는 결과에 표시되지
            않습니다.
          </span>
          {state.reasonCode === null ? null : <code>{state.reasonCode}</code>}
        </div>
      ) : (
        <section aria-labelledby="participant-results-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">SEARCH RESULTS</p>
              <h2 id="participant-results-title">마스킹 검색 결과</h2>
            </div>
            <span className="row-count">{state.items.length}개 항목</span>
          </div>
          {state.items.length === 0 ? (
            <div className="empty-state" role="status">
              <strong>일치하는 참여자가 없습니다.</strong>
              <span>캠페인 범위와 검색 조건을 확인해 주세요.</span>
            </div>
          ) : (
            <div className="participant-results">
              {state.items.map((participant) => (
                <article key={participant.participantId}>
                  <div className="participant-identity">
                    <div>
                      <p className="eyebrow">MASKED PARTICIPANT</p>
                      <h3>{participant.maskedName}</h3>
                      <p>{participant.maskedPhone}</p>
                    </div>
                    <StatusBadge tone={participant.ownershipState === 'OPERATOR' ? 'warning' : 'safe'}>
                      {participant.ownershipState === 'OPERATOR' ? '사람 소유' : '자동화 소유'}
                    </StatusBadge>
                  </div>
                  <dl className="evidence-grid">
                    <div>
                      <dt>신청 상태</dt>
                      <dd>{participant.applicationStatus}</dd>
                    </div>
                    <div>
                      <dt>블로거 등급</dt>
                      <dd>{participant.bloggerLevel === null ? '미제공' : `등급 ${participant.bloggerLevel}`}</dd>
                    </div>
                    <div>
                      <dt>블로그 일평균 방문자 수</dt>
                      <dd>
                        {participant.averageDailyVisitors === null
                          ? '미제공'
                          : participant.averageDailyVisitors.toLocaleString('ko-KR')}
                      </dd>
                    </div>
                    <div>
                      <dt>지역 근거</dt>
                      <dd>{participant.bloggerRegion ?? '미제공'}</dd>
                    </div>
                  </dl>
                  <p className="automation-state">자동화 상태 · {participant.automationState}</p>
                  <Link
                    className="text-link"
                    href={`/participants/${participant.participantId}?campaignId=${participant.campaignId}`}
                  >
                    전체 타임라인 보기
                  </Link>
                </article>
              ))}
            </div>
          )}
          {state.nextCursor === null ? null : (
            <button
              className="pagination-link"
              type="submit"
              form={formId}
              name="cursor"
              value={state.nextCursor}
              disabled={pending}
            >
              다음 결과
            </button>
          )}
        </section>
      )}
    </>
  )
}
