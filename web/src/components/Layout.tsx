import { Outlet } from 'react-router'
import { Nav } from './Nav'

export function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-line px-5 py-4 text-center text-xs text-muted">
        TaleTrek · by l1br3 · MIT
      </footer>
    </div>
  )
}
