import { ConfigurationEditor } from './configuration-editor'
import { ConsoleTable } from './console-table'
import { GovernedActionPanel } from './governed-action-panel'
import { ProductionBoundaryBanner } from './production-boundary-banner'
import { StatusBadge } from './status-badge'
import type { ConsoleScreen as ConsoleScreenModel } from '@/lib/console-contract'
import type { OperatorConsoleSession } from '@/lib/operator-session-contract'

export function ConsoleScreen({
  screen,
  session,
  campaignId,
}: Readonly<{ screen: ConsoleScreenModel; session: OperatorConsoleSession; campaignId: string }>) {
  return (
    <main id="main-content" className="page-content" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{screen.eyebrow}</p>
          <h1>{screen.title}</h1>
          <p>{screen.description}</p>
        </div>
        <StatusBadge tone={screen.badge.tone}>{screen.badge.label}</StatusBadge>
      </div>
      <ProductionBoundaryBanner />
      <section className="guidance-card" aria-labelledby="page-guidance-title">
        <p className="eyebrow">운영 원칙</p>
        <h2 id="page-guidance-title">현재 화면의 안전 경계</h2>
        <p>{screen.guidance}</p>
      </section>
      <section aria-labelledby="page-data-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">현재 상태</p>
            <h2 id="page-data-title">{screen.title} 목록</h2>
          </div>
          <span className="row-count">{screen.rows.length}개 항목</span>
        </div>
        <ConsoleTable caption={`${screen.title} 현재 상태`} columns={screen.columns} rows={screen.rows} />
      </section>
      {screen.editor === null ? null : <ConfigurationEditor editor={screen.editor} />}
      {screen.actions.length === 0 ? null : (
        <section aria-labelledby="page-actions-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">GOVERNED COMMANDS</p>
              <h2 id="page-actions-title">보호된 작업</h2>
            </div>
          </div>
          <div className="action-grid">
            {screen.actions.map((action) => (
              <GovernedActionPanel key={action.scenarioId} action={action} session={session} campaignId={campaignId} />
            ))}
          </div>
        </section>
      )}
    </main>
  )
}
