import type { ReactNode } from 'react'

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-5 border border-line bg-surface p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.15em] text-fg">
        <span className="text-accent" aria-hidden>
          ❯
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}
