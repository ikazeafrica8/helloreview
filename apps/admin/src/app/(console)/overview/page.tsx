import type { Metadata } from 'next'
import Link from 'next/link'
import { ProductionBoundaryBanner } from '@/components/production-boundary-banner'
import { StatusBadge } from '@/components/status-badge'
import { getOperatorConsoleGateway } from '@/lib/console-gateway'

export const metadata: Metadata = { title: '운영 현황' }

export default async function OverviewPage() {
  const metrics = await getOperatorConsoleGateway().overview()
  return (
    <main id="main-content" className="page-content" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">T112 · OPERATIONS OVERVIEW</p>
          <h1>운영 현황</h1>
          <p>자동화 상태, 사람의 책임, 실패와 중지를 한 화면에서 우선순위대로 확인합니다.</p>
        </div>
        <StatusBadge tone="safe">마스킹 기본값 적용</StatusBadge>
      </div>
      <ProductionBoundaryBanner />
      <section aria-labelledby="overview-metrics-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CURRENT ATTENTION</p>
            <h2 id="overview-metrics-title">주의가 필요한 운영 상태</h2>
          </div>
        </div>
        <div className="metric-grid">
          {metrics.map((metric) => (
            <article key={metric.label}>
              <StatusBadge tone={metric.tone}>{metric.label}</StatusBadge>
              <strong>{metric.value}</strong>
              <p>{metric.detail}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="overview-workflow" aria-labelledby="overview-flow-title">
        <div>
          <p className="eyebrow">OPERATOR FLOW</p>
          <h2 id="overview-flow-title">확인 → 책임 인수 → 근거 검토 → 안전한 재개</h2>
          <p>모든 변경 작업은 현재 버전, 범위, 중지 상태와 권한을 제출 직전에 다시 확인합니다.</p>
        </div>
        <div className="quick-links" aria-label="주요 운영 화면">
          <Link href="/participants">마스킹 참여자 검색</Link>
          <Link href="/human-review">인간 검토 대기열</Link>
          <Link href="/automation-pauses">자동화 중지 확인</Link>
          <Link href="/failed-jobs">실패 작업 확인</Link>
        </div>
      </section>
    </main>
  )
}
