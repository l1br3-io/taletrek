import { Outlet } from 'react-router'
import { GlobalUploadBanner } from './GlobalUploadBanner'
import { Nav } from './Nav'

export function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <GlobalUploadBanner />
      <main className="w-full flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="border-t border-line px-4 py-3 text-xs text-muted sm:px-6">
        taletrek · l1br3 · mit
      </footer>
    </div>
  )
}
