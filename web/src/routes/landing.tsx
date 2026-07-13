import { Link } from 'react-router'

const features = [
  'Upload PDF, EPUB, MOBI, or TXT',
  'On-device neural text-to-speech (Piper)',
  'Background playback that survives screen lock',
  'Clean audio — links, images, and footnotes skipped',
  'A personal library with reading progress',
  'Fully offline once your voice is downloaded',
]

export function Landing() {
  return (
    <div className="mx-auto max-w-3xl space-y-10">
      {/* Hero — a terminal session */}
      <section className="space-y-5">
        <div className="space-y-1">
          <p className="text-sm text-accent">
            <span aria-hidden>❯~ </span>taletrek
          </p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Every story is a <span className="text-accent">journey</span>.
          </h1>
        </div>
        <p className="max-w-prose text-base text-fg">
          Upload a book and your phone reads it aloud — entirely on-device. No cloud, no
          subscriptions, no app store. It strips the noise so only the story flows, then plays it as
          background audio that survives screen lock.
        </p>
        <p className="text-sm text-muted">
          A free, open-source reading companion by <span className="text-fg">l1br3</span>.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Link
            to="/library"
            className="inline-block border border-accent bg-accent-soft px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-elevated"
          >
            Browse your library
          </Link>
          <Link
            to="/reader"
            className="inline-block border border-line px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:border-muted"
          >
            Continue reading
          </Link>
        </div>
      </section>

      {/* Feature list — ❯ prompt bullets, no card wrapper */}
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            What&apos;s included
          </h2>
          <span className="h-px flex-1 bg-line" aria-hidden />
        </div>
        <ul className="space-y-2 text-sm text-fg">
          {features.map((text) => (
            <li key={text} className="flex items-start gap-2.5">
              <span className="mt-px shrink-0 text-accent" aria-hidden>
                ❯
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Footer links */}
      <p className="text-sm text-muted">
        Head to your{' '}
        <Link to="/library" className="text-accent underline">
          library
        </Link>{' '}
        or{' '}
        <Link to="/settings" className="text-accent underline">
          settings
        </Link>
        .
      </p>
    </div>
  )
}
