import { NavLink } from 'react-router'

const links = [
  { to: '/', label: 'Home', end: true },
  { to: '/reader', label: 'Reader', end: false },
  { to: '/settings', label: 'Settings', end: false },
] as const

export function Nav() {
  return (
    <header className="border-b border-line">
      <nav className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-4">
        <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="text-accent" aria-hidden>
            ❯~
          </span>
          <span>TaleTrek</span>
        </NavLink>
        <ul className="flex items-center gap-1">
          {links.map((l) => (
            <li key={l.to}>
              <NavLink
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  [
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    isActive ? 'bg-elevated text-fg' : 'text-muted hover:text-fg',
                  ].join(' ')
                }
              >
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  )
}
