import { Link } from 'react-router'

export function Landing() {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Every story is a <span className="text-accent">journey</span>.
        </h1>
        <p className="max-w-prose text-lg text-fg">
          TaleTrek turns any ebook into an audiobook you can listen to anywhere. Upload a file and
          your phone reads it aloud — entirely on-device. No cloud, no subscriptions, no app store.
        </p>
        <p className="text-sm text-muted">
          A free, open-source reading companion by <span className="text-fg">l1br3</span>.
        </p>
        <Link
          to="/reader"
          className="inline-block rounded-lg border border-accent bg-accent-soft px-5 py-2.5 font-medium text-accent transition-colors hover:bg-elevated"
        >
          Upload a book
        </Link>
      </section>

      <section className="rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          What's coming
        </h2>
        <ul className="space-y-2 text-fg">
          <li>📄 Upload PDF, EPUB, MOBI, or TXT</li>
          <li>🔊 On-device neural text-to-speech (Piper)</li>
          <li>🏃 Background playback that survives screen lock</li>
          <li>🧹 Clean audio — links, images, and footnotes skipped</li>
        </ul>
      </section>

      <p className="text-sm text-muted">
        This is an early build. Head to{' '}
        <a href="/reader" className="text-accent underline">
          Reader
        </a>{' '}
        or{' '}
        <a href="/settings" className="text-accent underline">
          Settings
        </a>
        .
      </p>
    </div>
  )
}
