import Link from 'next/link'
import { StatusBadge } from './status-badge'
import type { ConsoleColumn, ConsoleRow } from '@/lib/console-contract'

export function ConsoleTable({
  caption,
  columns,
  rows,
}: Readonly<{ caption: string; columns: readonly ConsoleColumn[]; rows: readonly ConsoleRow[] }>) {
  if (rows.length === 0)
    return (
      <div className="empty-state" role="status">
        <strong>표시할 항목이 없습니다.</strong>
        <span>필터나 검색 조건을 확인해 주세요.</span>
      </div>
    )

  return (
    <div className="table-scroll" tabIndex={0} aria-label={`${caption} 표 가로 스크롤 영역`}>
      <table className="console-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric === true ? 'numeric' : undefined}>
                {column.label}
              </th>
            ))}
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column, index) => (
                <td key={column.key} className={column.numeric === true ? 'numeric' : undefined}>
                  {index === 0 && row.href !== undefined ? (
                    <Link className="table-link" href={row.href}>
                      {row.values[column.key] ?? '—'}
                    </Link>
                  ) : (
                    (row.values[column.key] ?? '—')
                  )}
                </td>
              ))}
              <td>
                {row.status === undefined ? '—' : <StatusBadge tone={row.status.tone}>{row.status.label}</StatusBadge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
