import { PROVIDER_PRESETS } from '../../../lib/ai/providers'

const KEY_FILE_EXAMPLE = `{
  "apiKey": "sk-…",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "baseUrl": "https://api.openai.com/v1"
}`

/** Inline reference for the import-file schema, shown when the user taps "Format". */
export function KeyFileSchemaInfo() {
  const validIds = PROVIDER_PRESETS.map((p) => p.id).join(', ')
  return (
    <div className="space-y-2 rounded-lg border border-line bg-bg p-3 text-xs text-muted">
      <p className="text-fg">
        Import a <code className="font-mono">.json</code> file shaped like:
      </p>
      <pre className="overflow-x-auto rounded-md border border-line bg-surface p-2 font-mono text-[11px] leading-relaxed text-fg">
        {KEY_FILE_EXAMPLE}
      </pre>
      <ul className="space-y-0.5">
        <li>
          <code className="font-mono text-fg">apiKey</code> (string) — required; the rest are
          optional.
        </li>
        <li>
          <code className="font-mono text-fg">provider</code> — maps to one of: {validIds}. Unknown
          values fall back to <code className="font-mono">custom</code>.
        </li>
        <li>
          <code className="font-mono text-fg">model</code> /{' '}
          <code className="font-mono text-fg">baseUrl</code> — override the provider's defaults.
        </li>
      </ul>
      <p>
        The API key is held in memory for this tab only and is never written to disk by TaleTrek
        (ADR-0004). Export writes a <code className="font-mono">.json</code> file that round-trips
        on import — when a key is loaded it's included in the file (plaintext), so treat an exported
        file as a secret.
      </p>
    </div>
  )
}
