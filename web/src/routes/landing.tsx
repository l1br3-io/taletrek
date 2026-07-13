import { Eraser, FileText, Library, Moon, Plane, Volume2 } from 'lucide-react'
import { Link } from 'react-router'

const features = [
  { Icon: FileText, text: 'Upload PDF, EPUB, MOBI, or TXT' },
  { Icon: Volume2, text: 'On-device neural text-to-speech (Piper)' },
  { Icon: Moon, text: 'Background playback that survives screen lock' },
  { Icon: Eraser, text: 'Clean audio — links, images, and footnotes skipped' },
  { Icon: Library, text: 'A personal library with reading progress' },
  { Icon: Plane, text: 'Fully offline once your voice is downloaded' },
]

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
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/library"
            className="inline-block rounded-lg border border-accent bg-accent-soft px-5 py-2.5 font-medium text-accent transition-colors hover:bg-elevated"
          >
            Browse your library
          </Link>
          <Link
            to="/reader"
            className="inline-block rounded-lg border border-line px-5 py-2.5 font-medium text-fg transition-colors hover:border-muted"
          >
            Continue reading
          </Link>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          What's included
        </h2>
        <ul className="space-y-2 text-fg">
          {features.map(({ Icon, text }) => (
            <li key={text} className="flex items-center gap-2.5">
              <Icon className="h-4 w-4 shrink-0 text-accent" />
              {text}
            </li>
          ))}
        </ul>
      </section>

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
