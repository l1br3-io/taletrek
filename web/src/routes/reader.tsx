export function Reader() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Reader</h1>
      <div className="rounded-lg border border-dashed border-line bg-surface p-10 text-center">
        <p className="text-muted">
          No book loaded yet. Upload lands in{' '}
          <span className="text-fg">M1 — Upload &amp; Read</span>.
        </p>
      </div>
    </div>
  )
}
