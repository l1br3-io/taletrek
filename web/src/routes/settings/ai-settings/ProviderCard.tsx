import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Pencil,
  Plug,
  Star,
  Trash2,
  XCircle,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type ConnectionTestResult, testConnection } from '../../../lib/ai/connection-test'
import { downloadKeyFile } from '../../../lib/ai/exportKey'
import { getApiKey } from '../../../lib/ai/keyring'
import { getPreset } from '../../../lib/ai/providers'
import type { CloudProvider } from '../../../lib/ai/types'
import { KeyExportConfirmDialog } from '../KeyExportConfirmDialog'

interface ProviderCardProps {
  provider: CloudProvider
  isActive: boolean
  onSetActive: () => void
  onEdit: () => void
  onRemove: () => void
}

export function ProviderCard({
  provider,
  isActive,
  onSetActive,
  onEdit,
  onRemove,
}: ProviderCardProps) {
  const preset = getPreset(provider.presetId)
  const label = provider.label ?? preset.label
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const hasKey = !!getApiKey(provider.id)

  const handleExport = (): void => {
    // A key in memory will be written to the downloaded file — confirm first.
    if (hasKey) {
      setShowExport(true)
      return
    }
    downloadKeyFile(provider)
  }

  const statusEl: ReactNode = !hasKey ? (
    'Key: not set'
  ) : testing ? (
    'Testing…'
  ) : testResult?.type === 'success' ? (
    <>
      <CheckCircle2 className="h-3.5 w-3.5" /> Connected
    </>
  ) : testResult?.type === 'auth-error' ? (
    <>
      <XCircle className="h-3.5 w-3.5" /> Invalid key
    </>
  ) : testResult?.type === 'model-not-found' ? (
    <>
      <XCircle className="h-3.5 w-3.5" /> Model not found
    </>
  ) : testResult?.type === 'network' ? (
    <>
      <AlertTriangle className="h-3.5 w-3.5" />{' '}
      {preset.corsSafe ? 'Network error (retry)' : 'CORS / unreachable'}
    </>
  ) : testResult?.type === 'error' ? (
    <>
      <XCircle className="h-3.5 w-3.5" /> {testResult.status}
    </>
  ) : (
    'Key: ●●●●●● (untested)'
  )

  const handleTest = async (): Promise<void> => {
    const key = getApiKey(provider.id)
    if (!key) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnection(provider.baseUrl, key, provider.model)
      setTestResult(result)
    } catch {
      setTestResult({ type: 'network' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      className={[
        'rounded-lg border p-3 transition-colors',
        isActive ? 'border-accent bg-elevated' : 'border-line',
      ].join(' ')}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            {isActive && (
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent">
                Active
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {provider.model || 'No model set'} · {provider.baseUrl || 'No URL'}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={[
                'inline-flex items-center gap-1 text-xs',
                testResult?.type === 'success'
                  ? 'text-success'
                  : testResult
                    ? 'text-danger'
                    : 'text-muted',
              ].join(' ')}
            >
              {statusEl}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {!isActive && (
          <button
            type="button"
            onClick={onSetActive}
            className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium transition-colors hover:border-accent hover:text-accent"
          >
            <Star className="h-3.5 w-3.5" /> Set active
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={!hasKey || testing}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {testing ? (
            'Testing…'
          ) : (
            <>
              <Plug className="h-3.5 w-3.5" /> Test
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        <button
          type="button"
          onClick={handleExport}
          aria-label={`Export ${label}`}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Download className="h-3.5 w-3.5" /> Export
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-danger hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>
      </div>

      <KeyExportConfirmDialog
        open={showExport}
        label={label}
        onConfirm={() => {
          setShowExport(false)
          downloadKeyFile(provider)
        }}
        onCancel={() => setShowExport(false)}
      />
    </div>
  )
}
