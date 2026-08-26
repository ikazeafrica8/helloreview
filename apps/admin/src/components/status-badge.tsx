export function StatusBadge({ tone, children }: { tone: 'safe' | 'warning' | 'blocked'; children: React.ReactNode }) {
  return (
    <span className={`status-badge status-${tone}`} role="status">
      <span aria-hidden="true" className="status-marker" />
      {children}
    </span>
  )
}
