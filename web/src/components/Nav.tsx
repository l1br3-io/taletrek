import { Menu } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router'
import { GITHUB_URL } from '../lib/site'
import { GithubMark } from './GithubMark'

const links = [
  { to: '/', label: 'Home', end: true },
  { to: '/library', label: 'Library', end: false },
  { to: '/reader', label: 'Reader', end: false },
  { to: '/settings', label: 'Settings', end: false },
] as const

export function Nav() {
  const [open, setOpen] = useState(false)
  return (
    <header className="border-b border-line">
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <NavLink
          to="/"
          className="flex items-center gap-1.5 text-sm font-semibold tracking-tight"
          onClick={() => setOpen(false)}
        >
          <span className="text-accent" aria-hidden>
            ❯~
          </span>
          <span>taletrek</span>
        </NavLink>
        {/* Desktop links — plain text, ❯ marks the active route */}
        <ul className="hidden items-center gap-5 text-sm sm:flex">
          {links.map((l) => (
            <li key={l.to}>
              <NavLink
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  ['transition-colors', isActive ? 'text-fg' : 'text-muted hover:text-fg'].join(' ')
                }
              >
                {({ isActive }) => (
                  <span className="flex items-center gap-1">
                    {isActive && (
                      <span className="text-accent" aria-hidden>
                        ❯
                      </span>
                    )}
                    {l.label}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="TaleTrek on GitHub"
            className="text-muted transition-colors hover:text-accent"
          >
            <GithubMark className="h-5 w-5" />
          </a>
          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-muted sm:hidden"
            aria-label="Toggle navigation"
            aria-expanded={open}
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </nav>
      {/* Mobile drawer — hairline-separated rows */}
      {open && (
        <nav aria-label="Mobile navigation" className="border-t border-line bg-surface sm:hidden">
          <ul className="mx-auto flex w-full max-w-6xl flex-col">
            {links.map((l) => (
              <li key={l.to} className="border-b border-line last:border-b-0">
                <NavLink
                  to={l.to}
                  end={l.end}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-2 px-4 py-3 text-sm transition-colors',
                      isActive ? 'text-fg' : 'text-muted hover:text-fg',
                    ].join(' ')
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="text-accent" aria-hidden>
                          ❯
                        </span>
                      )}
                      {l.label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  )
}
