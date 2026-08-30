import { BundleExportAction } from '../../components/BundleExportAction'
import { BundleImportButton } from '../../components/BundleImportButton'
import { LibraryList } from './LibraryList'
import { useLibraryState } from './useLibraryState'

export function Library() {
  const {
    list,
    refresh,
    retryListLoad,
    navigate,
    handleRename,
    handleDelete,
    exportTarget,
    handleExportBundle,
    handleExportClose,
  } = useLibraryState()

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <span className="text-accent" aria-hidden>
            ❯
          </span>
          Library
        </h1>
        <BundleImportButton onImported={() => void refresh()} />
      </div>

      {list.type === 'loading' && <p className="text-muted">Loading…</p>}
      {list.type === 'error' && (
        <div role="alert" className="border border-danger bg-danger/10 p-4 text-danger">
          <p className="text-sm font-medium">Couldn't load your library.</p>
          <p className="mt-1 text-sm">{list.message}</p>
          <button
            type="button"
            onClick={retryListLoad}
            className="mt-3 border border-danger px-3 py-1.5 text-xs font-medium transition-colors hover:bg-danger/10"
          >
            Try again
          </button>
        </div>
      )}
      {list.type === 'ready' && (
        <LibraryList
          books={list.books}
          onOpen={(id) => navigate(`/reader/${id}`)}
          onDelete={handleDelete}
          onRename={handleRename}
          onExportBundle={(id) => void handleExportBundle(id)}
        />
      )}

      {/* Per-book "Export bundle" chooser (text-only vs full). The book list
          drives export from every card; this sheet does the IDB read → ZIP
          write → browser download. See BundleExportAction. */}
      {exportTarget && (
        <BundleExportAction
          bookId={exportTarget.id}
          title={exportTarget.title}
          onClose={handleExportClose}
        />
      )}
    </div>
  )
}
