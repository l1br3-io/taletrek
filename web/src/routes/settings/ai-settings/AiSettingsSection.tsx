import type { AiSettings } from '../../../lib/ai/types'
import { CloudProvidersSection } from './CloudProvidersSection'

interface AiSettingsSectionProps {
  ai: AiSettings
  onChange: (ai: AiSettings) => void
}

export function AiSettingsSection({ ai, onChange }: AiSettingsSectionProps) {
  const patch = (p: Partial<AiSettings>): void => {
    onChange({ ...ai, ...p })
  }

  return (
    <section className="space-y-5 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">AI transforms</h2>
        <button
          type="button"
          onClick={() => patch({ enabled: !ai.enabled })}
          aria-pressed={ai.enabled}
          aria-label="Toggle AI transforms"
          className={[
            'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
            ai.enabled ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted',
          ].join(' ')}
        >
          {ai.enabled ? 'On' : 'Off'}
        </button>
      </div>
      <p className="text-xs text-muted">
        Optional: clean up OCR noise, translate, summarize, or simplify a book after upload. Bring
        your own OpenAI-compatible cloud key.
      </p>

      {ai.enabled && (
        <div className="space-y-4">
          <CloudProvidersSection
            providers={ai.cloud.providers}
            activeProviderId={ai.cloud.activeProviderId}
            onChange={(cloud) => patch({ cloud })}
          />
        </div>
      )}
    </section>
  )
}
