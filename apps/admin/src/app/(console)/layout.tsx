import Link from 'next/link'
import { connection } from 'next/server'
import { OperatorNavigation } from '@/components/operator-navigation'
import { SessionRequired } from '@/components/session-required'
import { StatusBadge } from '@/components/status-badge'
import { getOperatorConsoleSession } from '@/lib/operator-session'

export default async function ConsoleLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Authentication is a request-time boundary. Never freeze a build-time session decision into HTML.
  await connection()
  const session = getOperatorConsoleSession()
  if (session === null) return <SessionRequired />

  return (
    <div className="console-frame">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/overview" aria-label="HelloReview 운영 콘솔 홈">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <span>
            <strong>HelloReview</strong>
            <small>운영 콘솔</small>
          </span>
        </Link>
        <OperatorNavigation />
      </aside>
      <div className="console-main">
        <header className="console-header">
          <div>
            <p className="eyebrow">보안 세션</p>
            <p className="session-name">{session.roleLabel}</p>
          </div>
          <div className="session-status" role="group" aria-label="현재 세션 상태">
            <StatusBadge tone="warning">{session.environmentLabel}</StatusBadge>
            <span className="assurance-label">{session.assuranceLabel}</span>
          </div>
        </header>
        <section className="global-pause-banner emergency-pause-banner" aria-label="긴급 자동화 중지 상태">
          <StatusBadge tone="blocked">긴급 자동화 중지 1건</StatusBadge>
          <p>지역 방문 캠페인의 새 자동화 진행이 긴급 중지되어 있습니다. 재개 전 현재 범위와 사유를 확인하세요.</p>
          <Link href="/automation-pauses">중지 상세 보기</Link>
        </section>
        {children}
      </div>
    </div>
  )
}
