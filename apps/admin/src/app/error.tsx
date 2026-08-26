'use client'

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" className="boundary-page" role="alert">
      <div className="boundary-card">
        <p className="eyebrow">RECOVERABLE ERROR</p>
        <h1>화면을 불러오지 못했습니다</h1>
        <p>민감한 오류 내용은 화면에 표시하지 않습니다. 다시 시도한 뒤 문제가 계속되면 운영 담당자에게 알려 주세요.</p>
        <button type="button" onClick={() => reset()}>
          다시 시도
        </button>
      </div>
    </main>
  )
}
