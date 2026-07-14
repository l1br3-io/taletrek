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

/**
 * Deterministic accent tint index (0–3) from the title hash. Each maps to a
 * fixed opacity of the accent color so covers vary subtly but stay within
 * the palette.
 */
const TINTS = [
  'bg-elevated text-accent',
  'bg-elevated text-accent',
  'bg-accent-soft text-accent',
  'bg-elevated text-fg',
] as const

interface BookCoverProps {
  title: string
  className?: string
}

/** Generated typography cover — monospace initials on a solid field (no art). */
export function BookCover({ title, className }: BookCoverProps) {
  const tint = TINTS[hashString(title) % TINTS.length]
  return (
    <div
      aria-hidden
      className={[
        'flex aspect-[3/4] items-center justify-center border border-line',
        tint,
        className ?? '',
      ].join(' ')}
    >
      <span className="text-2xl font-bold tracking-tight">{coverInitials(title)}</span>
    </div>
  )
}
