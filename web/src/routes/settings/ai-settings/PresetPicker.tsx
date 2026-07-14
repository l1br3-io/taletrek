import { CheckCircle2 } from 'lucide-react'
import { PROVIDER_PRESETS, type ProviderPreset } from '../../../lib/ai/providers'

interface PresetPickerProps {
  onPick: (preset: ProviderPreset) => void
  onCancel: () => void
}

export function PresetPicker({ onPick, onCancel }: PresetPickerProps) {
  return (
    <div className="space-y-3">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">
        Choose a provider
      </span>
      <div className="grid grid-cols-2 gap-2">
        {PROVIDER_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-lg border border-line p-3 text-left transition-colors hover:border-accent"
          >
            <span className="block font-medium">{p.label}</span>
            <span className="block text-xs text-muted">{p.description}</span>
            <span className="mt-1 block text-xs">
              {p.corsSafe ? (
                <span className="inline-flex items-center gap-1 text-success">
                  CORS <CheckCircle2 className="h-3.5 w-3.5" />
                </span>
              ) : p.id === 'custom' ? (
                <span className="text-muted">Enter URL manually</span>
              ) : (
                <span className="text-warning">CORS unverified</span>
              )}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-muted transition-colors hover:text-fg"
      >
        Cancel
      </button>
    </div>
  )
}
