import { ArrowRight, X } from 'lucide-react'
import type { PronunciationEntry } from '../../lib/clean/types'

export function PronunciationEditor({
  entries,
  onChange,
}: {
  entries: PronunciationEntry[]
  onChange: (entries: PronunciationEntry[]) => void
}) {
  const update = (id: string, patch: Partial<PronunciationEntry>) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  const remove = (id: string) => onChange(entries.filter((e) => e.id !== id))
  const add = () => onChange([...entries, { id: crypto.randomUUID(), find: '', replace: '' }])

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Pronunciation</h3>
      <p className="text-xs text-muted">
        Replace a word wherever it appears, so the narrator says it the way you want
        (case-insensitive, whole word).
      </p>
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2">
            <input
              type="text"
              value={entry.find}
              onChange={(e) => update(entry.id, { find: e.target.value })}
              placeholder="word"
              aria-label="word to replace"
              className="w-1/3 border border-line bg-surface px-3 py-1.5 text-sm"
            />
            <ArrowRight className="h-4 w-4 shrink-0 text-muted" />
            <input
              type="text"
              value={entry.replace}
              onChange={(e) => update(entry.id, { replace: e.target.value })}
              placeholder="replacement"
              aria-label="replacement"
              className="flex-1 border border-line bg-surface px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => remove(entry.id)}
              aria-label={`remove ${entry.find || 'entry'}`}
              className="border border-line px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-danger hover:text-danger"
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={add}
        className="border border-dashed border-line px-3 py-2 text-sm text-muted transition-colors hover:border-accent hover:text-accent"
      >
        + Add word
      </button>
    </section>
  )
}
