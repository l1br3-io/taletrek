import { Link } from 'react-router'

export function NotFound() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 text-left">
      <p className="text-sm text-accent">
        <span aria-hidden>❯ </span>
        404
      </p>
      <h1 className="text-4xl font-bold text-accent">page not found</h1>
      <p className="text-muted">This page wandered off the trail.</p>
      <Link
        to="/"
        className="inline-block border border-line bg-elevated px-4 py-2 text-sm text-fg transition-colors hover:border-muted"
      >
        ❯ Back home
      </Link>
    </div>
  )
}
