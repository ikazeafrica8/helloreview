'use client'

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ko">
      <body>
        <main className="boundary-page" role="alert">
          <div className="boundary-card">
            <p className="eyebrow">SYSTEM ERROR</p>
            <h1>운영 콘솔을 시작할 수 없습니다</h1>
            <p>세션과 시스템 설정을 다시 확인해 주세요.</p>
            <button type="button" onClick={() => reset()}>
              다시 시작
            </button>
          </div>
        </main>
      </body>
    </html>
  )
}
