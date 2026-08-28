import { AudioLines } from 'lucide-react'
import { useEffect } from 'react'
import { useServerVoices } from '../../hooks/useServerVoices'
import type { VoiceId } from '../../types'

interface SynthVoiceSheetProps {
  /** The book awaiting a voice pick; `null` keeps the sheet closed. */
  target: { id: string; title: string } | null
  onSelect: (voiceId: VoiceId) => void
  onClose: () => void
}

/**
 * Hosted per-book Synthesize flow (T16): picking "Synthesize" on a card
 * opens this sheet so the user chooses the voice the **server** will
 * synthesize under (the book's next voice — a different one re-voices it).
 * Local mode keeps its one-tap resynth under the settings voice; hosted
 * voices need no download, so a plain list suffices.
 */
export function SynthVoiceSheet({ target, onSelect, onClose }: SynthVoiceSheetProps) {
  const voices = useServerVoices()

  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [target, onClose])

  if (!target) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="synth-voice-title"
    >
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-surface p-5">
        <div className="flex items-start gap-2">
          <AudioLines className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
          <h2 id="synth-voice-title" className="text-base font-semibold text-fg">
            Synthesize “{target.title.slice(0, 40)}”
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted">
          Pick the voice your server synthesizes this book under. Choosing a different voice than
          before re-voices it.
        </p>
        {voices.type === 'ready' && (
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {voices.voices.map((voice) => (
              <li key={voice.id}>
                <button
                  type="button"
                  onClick={() => onSelect(voice.id)}
                  className="flex w-full items-center justify-between rounded-lg border border-line p-3 text-left transition-colors hover:border-accent"
                >
                  <span>
                    <span className="block font-medium">
                      {voice.name} <span className="text-muted">· {voice.language}</span>
                    </span>
                    <span className="block text-xs text-muted capitalize">{voice.quality}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {voices.type === 'error' && (
          <p className="text-sm text-warning">Couldn’t load voices — {voices.message}</p>
        )}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
