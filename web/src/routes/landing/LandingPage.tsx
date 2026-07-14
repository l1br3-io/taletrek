import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { GithubMark } from '../../components/GithubMark'
import { GITHUB_URL } from '../../lib/site'
import { comparison, faqs, features, heroBadges, moments, steps } from './landing-content'

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-muted">{children}</h2>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  )
}

function TerminalDemo() {
  return (
    <div className="border border-line bg-surface font-mono text-sm" aria-hidden>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-xs">
        <span className="text-accent">❯~</span>
        <span className="text-fg/80">taletrek play dune.epub</span>
      </div>
      <div className="space-y-2 px-4 py-4">
        <div className="flex gap-3">
          <span className="w-12 shrink-0 text-muted">parse</span>
          <span className="text-fg/90">487 pages · 18 chapters</span>
        </div>
        <div className="flex gap-3">
          <span className="w-12 shrink-0 text-muted">clean</span>
          <span className="text-fg/90">−1,204 links · −89 footnotes · −312 page-refs</span>
        </div>
        <div className="flex gap-3">
          <span className="w-12 shrink-0 text-muted">voice</span>
          <span className="text-fg/90">piper · en_US · lessac · medium</span>
        </div>
        <div className="flex gap-3 pt-1">
          <span className="text-accent">▸</span>
          <p className="font-reader text-base italic leading-relaxed text-fg">
            playing <span className="text-muted not-italic">&#8220;</span>In the week before their
            departure to Arrakis, when all the final arrangements were being made
            <span className="text-muted not-italic">&#8230;&#8221;</span>
          </p>
        </div>
        <div className="pt-2 text-accent">
          ❯ <span className="tt-cursor">█</span>
        </div>
      </div>
    </div>
  )
}

function Cell({ value, highlight }: { value: boolean | string; highlight?: boolean }) {
  if (value === true)
    return <span className={highlight ? 'font-medium text-accent' : 'text-fg'}>Yes</span>
  if (value === false) return <span className="text-muted">No</span>
  return <span className={highlight ? 'text-accent' : 'text-fg/90'}>{value}</span>
}

export function Landing() {
  return (
    <div className="mx-auto max-w-6xl space-y-20 py-4 sm:space-y-24">
      {/* Hero */}
      <section className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
        <div className="space-y-6">
          <p className="font-mono text-sm text-accent">
            <span aria-hidden>❯~ </span>taletrek
          </p>
          <h1 className="font-reader text-5xl font-semibold leading-[1.05] sm:text-6xl">
            Every story is a <span className="italic text-accent">journey</span>.
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-fg/90">
            Upload a book or document and your phone reads it aloud with on-device neural speech. No
            cloud, no subscription, no app store. TaleTrek strips the noise so only the story flows
            — then keeps playing after you lock the screen.
          </p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs uppercase tracking-[0.18em] text-muted">
            {heroBadges.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link
              to="/library"
              className="inline-flex items-center gap-2 bg-accent px-5 py-2.5 text-sm font-medium text-bg transition-opacity hover:opacity-90"
            >
              Open your library <span aria-hidden>→</span>
            </Link>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 border border-line px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:border-accent hover:text-accent"
            >
              <GithubMark className="h-4 w-4" /> Star on GitHub
            </a>
          </div>
        </div>
        <TerminalDemo />
      </section>

      {/* Use cases — hands-full moments */}
      <section className="space-y-6">
        <Eyebrow>When you can&apos;t read</Eyebrow>
        <div className="max-w-3xl space-y-4">
          <p className="font-reader text-3xl leading-[1.18] text-fg sm:text-4xl">
            Your hands are full. <span className="text-accent">Your ears are free.</span>
          </p>
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            TaleTrek keeps the story going through the moments you can&apos;t look at a screen —
            phone locked, hands busy, eyes elsewhere. Press play and put it in your pocket.
          </p>
        </div>
        <ul className="grid grid-cols-2 gap-px overflow-hidden border border-line bg-line sm:grid-cols-3">
          {moments.map((m) => (
            <li
              key={m.label}
              className="flex flex-col items-center gap-3 bg-bg px-4 py-7 text-center"
            >
              <m.icon className="h-6 w-6 text-accent" aria-hidden />
              <span className="text-sm text-fg">{m.label}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Thesis */}
      <section className="space-y-5">
        <Eyebrow>The thesis</Eyebrow>
        <p className="max-w-3xl font-reader text-3xl leading-[1.18] text-fg sm:text-4xl">
          Audiobooks cost money. Browser readers stop when the screen locks.{' '}
          <span className="text-accent">TaleTrek does neither</span> — your phone does all the work,
          offline, for free.
        </p>
      </section>

      {/* How it works */}
      <section className="space-y-6">
        <Eyebrow>From file to voice, on your device</Eyebrow>
        <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s) => (
            <li key={s.n} className="space-y-3">
              <div className="flex items-center gap-2">
                <s.icon className="h-5 w-5 text-accent" aria-hidden />
                <span className="font-mono text-xs text-muted">{s.n}</span>
              </div>
              <p className="font-medium text-fg">{s.label}</p>
              <p className="text-sm leading-relaxed text-muted">{s.desc}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Features */}
      <section className="space-y-6">
        <Eyebrow>What you get</Eyebrow>
        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="flex gap-3">
              <f.icon className="h-5 w-5 shrink-0 text-accent" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium text-fg">{f.title}</p>
                <p className="text-sm leading-relaxed text-muted">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Comparison */}
      <section className="space-y-6">
        <Eyebrow>How it compares</Eyebrow>
        <div className="overflow-x-auto border border-line">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="py-3 pl-4 pr-4 font-mono text-xs font-medium uppercase tracking-wider text-muted">
                  <span className="sr-only">Capability</span>
                </th>
                {comparison.cols.map((c, i) => (
                  <th
                    key={c}
                    className={`px-4 py-3 font-medium ${i === 0 ? 'text-accent' : 'text-fg'}`}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => (
                <tr key={row.label} className="border-b border-line/60 last:border-b-0">
                  <th
                    scope="row"
                    className="py-3 pl-4 pr-4 text-left font-mono text-xs uppercase tracking-wider text-muted"
                  >
                    {row.label}
                  </th>
                  {row.cells.map((cell, i) => (
                    <td
                      key={comparison.cols[i]}
                      className={`px-4 py-3 ${i === 0 ? 'border-l-2 border-accent bg-accent-soft' : ''}`}
                    >
                      <Cell value={cell} highlight={i === 0} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section className="space-y-6">
        <Eyebrow>Questions</Eyebrow>
        <dl className="divide-y divide-line">
          {faqs.map((f) => (
            <div key={f.q} className="grid gap-2 py-5 sm:grid-cols-[1fr_2fr] sm:gap-8">
              <dt className="font-medium text-fg">{f.q}</dt>
              <dd className="text-sm leading-relaxed text-muted">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Final CTA */}
      <section className="border border-line bg-surface px-6 py-12 text-center sm:px-12 sm:py-14">
        <p className="font-reader text-3xl text-fg sm:text-4xl">Bring a book. Hear it told.</p>
        <p className="mt-3 text-sm text-muted">Free, offline, and yours to fork.</p>
        <Link
          to="/library"
          className="mt-6 inline-flex items-center gap-2 bg-accent px-5 py-2.5 text-sm font-medium text-bg transition-opacity hover:opacity-90"
        >
          Open your library <span aria-hidden>→</span>
        </Link>
      </section>
    </div>
  )
}
