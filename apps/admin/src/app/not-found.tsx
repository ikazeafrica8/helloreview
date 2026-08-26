import Link from 'next/link'

export default function NotFound() {
  return (
    <main id="main-content" className="boundary-page">
      <div className="boundary-card">
        <p className="eyebrow">404</p>
        <h1>요청한 운영 화면을 찾을 수 없습니다</h1>
        <p>주소를 확인하거나 운영 현황으로 돌아가세요.</p>
        <Link className="button-link" href="/overview">
          운영 현황으로 이동
        </Link>
      </div>
    </main>
  )
}
