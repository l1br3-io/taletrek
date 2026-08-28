import { Download, Upload } from 'lucide-react'
import { useState } from 'react'
import { useDatasource } from '../../context/datasource'
import { BackupTooLargeError, CorruptBackupError, type ImportReport } from '../../lib/datasource'

type BackupStatus =
  | { type: 'idle' }
  | { type: 'busy'; label: string }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string }

function formatReport(report: ImportReport): string {
  const parts = [`${report.booksImported} book${report.booksImported === 1 ? '' : 's'} imported`]
  if (report.booksSkipped > 0) {
    parts.push(`${report.booksSkipped} already present (kept as-is)`)
  }
  if (report.settingsApplied) parts.push('settings restored')
  return `${parts.join(', ')}.`
}

export function BackupSection({ onImported }: { onImported: () => void }) {
  const { library } = useDatasource()
  const [status, setStatus] = useState<BackupStatus>({ type: 'idle' })

  const handleExport = async () => {
    setStatus({ type: 'busy', label: 'Preparing backup…' })
    try {
      const blob = await library.exportBackup()
      const date = new Date().toISOString().slice(0, 10)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `taletrek-backup-${date}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setStatus({ type: 'done', message: 'Backup downloaded.' })
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Export failed.',
      })
    }
  }

  const handleImportFile = async (file: File) => {
    if (
      !window.confirm(
        'Import this backup? New books will be added, books already on this device are kept as-is, and your settings will be overwritten.',
      )
    ) {
      return
    }
    setStatus({ type: 'busy', label: 'Importing…' })
    try {
      const report = await library.importBackup(file)
      onImported()
      setStatus({ type: 'done', message: formatReport(report) })
    } catch (err) {
      const message =
        err instanceof BackupTooLargeError
          ? err.message
          : err instanceof CorruptBackupError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Import failed.'
      setStatus({ type: 'error', message })
    }
  }

  return (
    <section className="space-y-5 border border-line bg-surface p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.15em] text-fg">
        <span className="text-accent" aria-hidden>
          ❯
        </span>
        Backup &amp; transfer
      </h2>
      <p className="text-xs text-muted">
        Export your library and settings to a file, then import it on another device to pick up
        where you left off. Books already on the target device are kept as-is. Audio cache
        isn&apos;t included — it rebuilds as you read.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={status.type === 'busy'}
          className="inline-flex items-center gap-2 border border-line px-4 py-2 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> Export backup
        </button>
        <label className="inline-flex cursor-pointer items-center gap-2 border border-line px-4 py-2 text-sm font-medium transition-colors hover:border-accent hover:text-accent">
          <Upload className="h-4 w-4" /> Import backup
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = '' // allow re-selecting the same file
              if (file) void handleImportFile(file)
            }}
          />
        </label>
      </div>
      {status.type === 'busy' && (
        <p className="text-xs text-muted" role="status">
          {status.label}
        </p>
      )}
      {status.type === 'done' && (
        <p className="text-xs text-accent" role="status">
          {status.message}
        </p>
      )}
      {status.type === 'error' && (
        <p className="text-xs text-danger" role="alert">
          {status.message}
        </p>
      )}
    </section>
  )
}
