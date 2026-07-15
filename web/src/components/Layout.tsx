import { Link, Outlet } from 'react-router'
import { GITHUB_URL } from '../lib/site'
import { GithubMark } from './GithubMark'
import { GlobalUploadBanner } from './GlobalUploadBanner'
import { Nav } from './Nav'

export function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <Nav />
      <GlobalUploadBanner />
      <main className="w-full flex-1 px-3 py-4 sm:px-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="hidden border-t border-line sm:block">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <span className="text-accent" aria-hidden>
                ❯~
              </span>{' '}
              taletrek
            </p>
            <p className="font-reader text-sm text-fg/90">Every story is a journey.</p>
            <p className="text-xs text-muted">No accounts. No cloud. No tracking.</p>
          </div>
          <div className="flex flex-col gap-3 sm:items-end">
            <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <Link to="/library" className="transition-colors hover:text-fg">
                Library
              </Link>
              <Link to="/reader" className="transition-colors hover:text-fg">
                Reader
              </Link>
              <Link to="/settings" className="transition-colors hover:text-fg">
                Settings
              </Link>
            </nav>
            <div className="flex items-center gap-3 text-xs text-muted">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-accent"
              >
                <GithubMark className="h-4 w-4" /> Source
              </a>
              <span aria-hidden>·</span>
              <span>MIT · by l1br3</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
