'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { OPERATOR_NAVIGATION } from '@/lib/navigation'

export function OperatorNavigation() {
  const pathname = usePathname()
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <button
        type="button"
        className="navigation-toggle"
        aria-label={expanded ? '운영 메뉴 닫기' : '운영 메뉴 열기'}
        aria-expanded={expanded}
        aria-controls="operator-navigation"
        onClick={() => setExpanded((current) => !current)}
      >
        운영 메뉴
      </button>
      <nav
        id="operator-navigation"
        aria-label="운영자 기본 메뉴"
        className="operator-navigation"
        data-expanded={expanded}
      >
        {OPERATOR_NAVIGATION.map((section) => (
          <section className="navigation-section" key={section.label} aria-labelledby={`nav-${section.label}`}>
            <h2 id={`nav-${section.label}`}>{section.label}</h2>
            <ul>
              {section.items.map((item) => {
                const current = pathname === item.href || pathname.startsWith(`${item.href}/`)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={current ? 'page' : undefined}
                      onClick={() => setExpanded(false)}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </nav>
    </>
  )
}
