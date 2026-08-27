import { StatusBadge } from './status-badge'

export function ConsoleAccessDenied() {
  return (
    <main id="main-content" className="boundary-page" tabIndex={-1}>
      <div className="boundary-card">
        <p className="eyebrow">FAIL CLOSED</p>
        <StatusBadge tone="blocked">범위 접근 차단</StatusBadge>
        <h1>요청한 운영 범위에 대한 권한이 없습니다</h1>
        <p>현재 세션의 canonical action과 캠페인 범위가 모두 확인된 경우에만 운영 데이터를 조회합니다.</p>
        <div className="boundary-notice" role="alert">
          <code>OPERATOR_CONSOLE_READ_DENIED</code>
        </div>
      </div>
    </main>
  )
}
