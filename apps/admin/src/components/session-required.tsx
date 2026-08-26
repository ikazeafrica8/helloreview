import { StatusBadge } from './status-badge'

export function SessionRequired() {
  return (
    <main id="main-content" className="boundary-page" tabIndex={-1}>
      <div className="boundary-card">
        <p className="eyebrow">HELLOREVIEW OPERATIONS</p>
        <StatusBadge tone="blocked">접근 차단</StatusBadge>
        <h1>승인된 운영자 세션이 필요합니다</h1>
        <p>
          운영 콘솔은 현재 안전하게 잠겨 있습니다. 승인된 SSO 또는 로컬 MFA 어댑터가 연결되기 전에는 실제 운영자
          로그인과 민감정보 접근을 사용할 수 없습니다.
        </p>
        <div className="boundary-notice" role="alert">
          테스트 환경에서는 <code>ADMIN_CONSOLE_SESSION_MODE=test_fixture</code>로 비식별 테스트 세션만 사용할 수
          있습니다. 프로덕션에서는 이 설정이 거부됩니다.
        </div>
      </div>
    </main>
  )
}
