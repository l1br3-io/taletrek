import { Link } from 'react-router'

export function NotFound() {
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-6xl font-bold text-accent">404</h1>
      <p className="text-muted">This page wandered off the trail.</p>
      <Link to="/" className="inline-block rounded-md bg-elevated px-4 py-2 text-sm text-fg">
        Back home
      </Link>
    </div>
  )
}
