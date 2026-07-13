import { BookOpen, Home, Library, Menu, Settings } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router'

const links = [
  { to: '/', label: 'Home', end: true, Icon: Home },
  { to: '/library', label: 'Library', end: false, Icon: Library },
  { to: '/reader', label: 'Reader', end: false, Icon: BookOpen },
  { to: '/settings', label: 'Settings', end: false, Icon: Settings },
] as const

export function Nav() {
  const [open, setOpen] = useState(false)
  return (
    <header className="border-b border-line">
      <nav className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3 sm:px-5 sm:py-4">
        <NavLink
          to="/"
          className="flex items-center gap-2 font-semibold tracking-tight"
          onClick={() => setOpen(false)}
        >
          <span className="text-accent" aria-hidden>
            ❯~
          </span>
          <span>TaleTrek</span>
        </NavLink>
        {/* Desktop links */}
        <ul className="hidden items-center gap-1 sm:flex">
          {links.map((l) => (
            <li key={l.to}>
              <NavLink
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  [
                    'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                    isActive ? 'bg-elevated text-fg' : 'text-muted hover:text-fg',
                  ].join(' ')
                }
              >
                <l.Icon className="h-4 w-4" />
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-line px-2 py-1 text-muted sm:hidden"
          aria-label="Toggle navigation"
          aria-expanded={open}
        >
          <Menu className="h-5 w-5" />
        </button>
      </nav>
      {/* Mobile drawer */}
      {open && (
        <nav aria-label="Mobile navigation" className="border-t border-line bg-surface sm:hidden">
          <ul className="mx-auto flex w-full max-w-3xl flex-col px-4 py-2">
            {links.map((l) => (
              <li key={l.to}>
                <NavLink
                  to={l.to}
                  end={l.end}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                      isActive ? 'bg-elevated text-fg' : 'text-muted hover:text-fg',
                    ].join(' ')
                  }
                >
                  <l.Icon className="h-4 w-4" />
                  {l.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  )
}
