import { Info } from 'lucide-react'
import { useState } from 'react'

interface InfoDisclosureProps {
  children: React.ReactNode
}

/**
 * Info icon that toggles an expandable help-text panel. Reusable across
 * Settings, the transform picker, and the outline sheet. Matches the inline-
 * disclosure pattern already used in `KeyFileSchemaInfo`.
 */
export function InfoDisclosure({ children }: InfoDisclosureProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="More information"
        className="inline-flex items-center text-muted hover:text-fg"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-line bg-elevated p-3 text-xs text-muted">
          {children}
        </div>
      )}
    </div>
  )
}
