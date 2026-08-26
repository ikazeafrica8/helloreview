import { StatusBadge } from './status-badge'

export function ProductionBoundaryBanner() {
  return (
    <section className="production-boundary" aria-labelledby="console-boundary-title">
      <div>
        <p className="eyebrow">프로덕션 경계</p>
        <h2 id="console-boundary-title">실제 인증·RBAC·민감정보 정책 승인 전</h2>
      </div>
      <p>
        현재 화면은 가명화된 결정론 fixture만 사용합니다. 명령 결과는 검증용 영수증이며 실제 데이터베이스나 외부
        시스템을 변경하지 않습니다.
      </p>
      <StatusBadge tone="blocked">프로덕션 변경 차단</StatusBadge>
    </section>
  )
}
