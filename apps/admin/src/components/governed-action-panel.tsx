'use client'

import { useId, useState } from 'react'
import { evaluateGovernedAction, type ConsoleAction, type GovernedActionResult } from '@/lib/console-contract'
import type { OperatorConsoleSession } from '@/lib/operator-session-contract'

export function GovernedActionPanel({
  action,
  session,
  campaignId,
}: Readonly<{ action: ConsoleAction; session: OperatorConsoleSession; campaignId: string }>) {
  const [expanded, setExpanded] = useState(false)
  const [result, setResult] = useState<GovernedActionResult | null>(null)
  const reasonId = useId()
  const confirmationId = useId()
  const panelId = useId()

  return (
    <article className={`action-card action-${action.effect}`} data-action-id={action.scenarioId}>
      <div className="action-card-heading">
        <div>
          <p className="action-code">{action.scenarioId}</p>
          <h3>{action.label}</h3>
        </div>
        <span className={`action-permission permission-${action.permission}`}>
          {action.permission === 'fixture_allowed' ? 'fixture 허용' : '정책 차단'}
        </span>
      </div>
      <p>{action.description}</p>
      <p className="authorization-action">
        권한 행위 · <code>{action.authorizationAction ?? 'UNMAPPED_FIXTURE_SCENARIO'}</code>
      </p>
      {action.permission === 'policy_blocked' ? (
        <p className="version-withheld">정책 승인 전에는 대상 버전 정보를 표시하지 않습니다.</p>
      ) : (
        <dl className="action-facts">
          <div>
            <dt>예상 버전</dt>
            <dd>{action.expectedVersion === null ? '해당 없음' : `v${action.expectedVersion}`}</dd>
          </div>
          <div>
            <dt>현재 버전</dt>
            <dd>{action.currentVersion === null ? '해당 없음' : `v${action.currentVersion}`}</dd>
          </div>
        </dl>
      )}
      <button
        type="button"
        className="secondary-button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => {
          setExpanded((current) => !current)
          setResult(null)
        }}
      >
        {expanded ? '검토 닫기' : '작업 검토'}
      </button>
      <form
        id={panelId}
        className="action-form"
        hidden={!expanded}
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          setResult(
            evaluateGovernedAction({
              action,
              session,
              campaignId,
              reason: String(data.get('reason') ?? ''),
              confirmation: String(data.get('confirmation') ?? ''),
            }),
          )
        }}
      >
        {action.requiresReason ? (
          <label htmlFor={reasonId}>
            작업 사유 <span aria-hidden="true">*</span>
            <textarea id={reasonId} name="reason" minLength={3} maxLength={500} required />
          </label>
        ) : null}
        {action.confirmationPhrase === null ? null : (
          <label htmlFor={confirmationId}>
            확인을 위해 “{action.confirmationPhrase}” 입력 <span aria-hidden="true">*</span>
            <input id={confirmationId} name="confirmation" autoComplete="off" required />
          </label>
        )}
        <p className="action-warning">
          {action.effect === 'preview'
            ? '이 작업은 비변경 미리보기입니다.'
            : '제출 직전 권한, 범위, 현재 버전과 중지 상태를 다시 검증해야 합니다.'}
        </p>
        <button type="submit">fixture 명령 검증</button>
      </form>
      {result === null ? null : (
        <p
          className={`action-result ${result.accepted ? 'result-safe' : 'result-blocked'}`}
          role="status"
          aria-live="polite"
        >
          <strong>{result.reasonCode}</strong>
          <span>{result.message}</span>
        </p>
      )}
    </article>
  )
}
