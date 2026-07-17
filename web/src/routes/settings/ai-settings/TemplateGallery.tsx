import { TRANSFORM_TEMPLATES } from '../../../lib/ai/templates'
import type { TransformDefinition, TransformTemplate } from '../../../lib/ai/types'
import { newTransformDefId } from '../../../lib/ai/types'

interface TemplateGalleryProps {
  onPick: (def: TransformDefinition) => void
  onBlank: () => void
}

function templateToDef(t: TransformTemplate): TransformDefinition {
  return {
    id: newTransformDefId(),
    label: t.label,
    hint: t.hint,
    desc: t.desc,
    systemPrompt: t.systemPrompt,
    params: t.params,
  }
}

export function TemplateGallery({ onPick, onBlank }: TemplateGalleryProps) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Start from a template or build from scratch.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TRANSFORM_TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onPick(templateToDef(t))}
            className="rounded-lg border border-line p-3 text-left transition-colors hover:border-accent"
          >
            <div className="font-medium text-sm">{t.label}</div>
            <div className="mt-1 text-xs text-muted">{t.hint}</div>
            <div className="mt-1 text-xs text-muted/70 line-clamp-2">{t.desc}</div>
          </button>
        ))}
      </div>
      <button type="button" onClick={onBlank} className="text-xs text-accent hover:underline">
        Or start from scratch
      </button>
    </div>
  )
}
