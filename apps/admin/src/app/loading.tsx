export default function Loading() {
  return (
    <main id="main-content" className="boundary-page" aria-busy="true" aria-live="polite">
      <div className="boundary-card">
        <p className="eyebrow">LOADING</p>
        <h1>운영 정보를 불러오는 중입니다</h1>
        <p>현재 상태를 확인하고 있습니다.</p>
      </div>
    </main>
  )
}
