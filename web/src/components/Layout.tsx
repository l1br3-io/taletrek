import { Outlet } from 'react-router'
import { GlobalUploadBanner } from './GlobalUploadBanner'
import { Nav } from './Nav'

export function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <GlobalUploadBanner />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:px-5 sm:py-8">
        <Outlet />
      </main>
      <footer className="border-t border-line px-4 py-4 text-center text-xs text-muted sm:px-5">
        TaleTrek · by l1br3 · MIT
      </footer>
    </div>
  )
}
