const COVER_GRADIENTS = [
  'from-emerald-500/30 to-emerald-900/50',
  'from-sky-500/30 to-sky-900/50',
  'from-amber-500/30 to-amber-900/50',
  'from-violet-500/30 to-violet-900/50',
  'from-rose-500/30 to-rose-900/50',
  'from-teal-500/30 to-teal-900/50',
] as const

function hashString(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * Derive 2–3 cover initials from a title: first letters of the first two
 * significant words, uppercased. Single-word titles take the first two chars.
 */
export function coverInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  const first = words[0]
  if (!first) return '?'
  if (words.length === 1) return first.slice(0, 2).toUpperCase()
  const a = first[0] ?? ''
  const b = words[1]?.[0] ?? ''
  return (a + b).toUpperCase() || '?'
}

interface BookCoverProps {
  title: string
  className?: string
}

/** Generated typography cover — initials on a deterministic gradient (no art). */
export function BookCover({ title, className }: BookCoverProps) {
  const gradient = COVER_GRADIENTS[hashString(title) % COVER_GRADIENTS.length]
  return (
    <div
      aria-hidden
      className={[
        'flex aspect-[3/4] items-center justify-center rounded-lg bg-gradient-to-br',
        gradient,
        className ?? '',
      ].join(' ')}
    >
      <span className="text-3xl font-bold tracking-tight text-fg/90 drop-shadow-sm">
        {coverInitials(title)}
      </span>
    </div>
  )
}
