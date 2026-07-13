import { Compass } from 'lucide-react'
import { Link } from 'react-router'

export function NotFound() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 text-center">
      <Compass className="mx-auto h-10 w-10 text-muted" />
      <h1 className="text-6xl font-bold text-accent">404</h1>
      <p className="text-muted">This page wandered off the trail.</p>
      <Link to="/" className="inline-block rounded-md bg-elevated px-4 py-2 text-sm text-fg">
        Back home
      </Link>
    </div>
  )
}
