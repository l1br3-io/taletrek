import { X } from 'lucide-react'
import { LibraryList } from './LibraryList'
import { OutlineSheet } from './OutlineSheet'
import { PronunciationReview } from './PronunciationReview'
import { UploadBookModal } from './UploadBookModal'
import { UploadButton } from './UploadButton'
import { useLibraryState } from './useLibraryState'

export function Library() {
  const {
    ai,
    online,
    engine,
    transform,
    outline,
    hints,
    list,
    runCtx,
    hintsTitle,
    parseState,
    uploadBusy,
    runInitialOps,
    handleSelect,
    onRunProcess,
    onRunCancel,
    handleRename,
    handleEdit,
    outlineBookId,
    handleOutline,
    handleOutlineAutoDetect,
    handleOutlineAi,
    handleOutlineClose,
    handlePronunciation,
    onHintsAccept,
    onHintsClose,
    handleDelete,
    handleResynthesize,
    dismissParseError,
    synthesizeOnUpload,
    navigate,
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
        <UploadButton onSelect={handleSelect} disabled={uploadBusy} />
      </div>

      {parseState.type === 'parsing' && (
        <div
          role="status"
          className="flex items-center gap-3 border border-accent bg-accent-soft p-4 text-accent"
        >
          <span
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
          <span className="text-sm">Parsing “{parseState.fileName}”…</span>
        </div>
      )}
      {parseState.type === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between border border-danger bg-danger/10 p-4 text-danger"
        >
          <span className="text-sm">{parseState.message}</span>
          <button
            type="button"
            onClick={dismissParseError}
            aria-label="Dismiss error"
            className="ml-4 text-xs text-danger/70 hover:text-danger"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {outline.state.type === 'running' && (
        <div role="status" className="border border-accent bg-accent-soft p-4 text-accent">
          Generating outline…
        </div>
      )}
      {outline.state.type === 'done' && (
        <div
          role="status"
          className="flex items-center justify-between border border-accent bg-accent-soft p-4 text-accent"
        >
          <span>{outline.state.message}</span>
          <button
            type="button"
            onClick={outline.reset}
            aria-label="Dismiss outline message"
            className="ml-4 text-xs text-accent/70 hover:text-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {outline.state.type === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between border border-danger bg-danger/10 p-4 text-danger"
        >
          <span>{outline.state.message}</span>
          <button
            type="button"
            onClick={outline.reset}
            aria-label="Dismiss error message"
            className="ml-4 text-xs text-danger/70 hover:text-danger"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {list.type === 'loading' && <p className="text-muted">Loading…</p>}
      {list.type === 'ready' && (
        <LibraryList
          books={list.books}
          onOpen={(id) => navigate(`/reader/${id}`)}
          onDelete={handleDelete}
          onEdit={ai.enabled ? handleEdit : undefined}
          onPronunciation={ai.enabled && online ? handlePronunciation : undefined}
          onOutline={handleOutline}
          onResynthesize={synthesizeOnUpload !== 'off' ? handleResynthesize : undefined}
          onRename={handleRename}
        />
      )}

      {/* Process modal: always shown after upload when AI is enabled (opt-in skip).
          Also used for Reprocess (re-parse original → transform). Cancel/Close
          on post-upload proceeds to synth; on reprocess stays in library. */}
      <UploadBookModal
        open={runCtx !== null}
        state={transform.state}
        defs={ai.transformDefs}
        initialOps={runInitialOps}
        onProcess={onRunProcess}
        onCancel={onRunCancel}
        online={online}
      />

      <OutlineSheet
        open={outlineBookId !== null}
        state={outline.state}
        format={outlineBookId ? (runCtx?.book.format ?? 'txt') : 'txt'}
        online={online}
        onAutoDetect={() => void handleOutlineAutoDetect()}
        onDetectAi={engine ? () => void handleOutlineAi() : undefined}
        onClose={handleOutlineClose}
      />

      {/* Pronunciation review: scans the opening chapter for name/foreign-word
          candidates; accepted entries merge into the global dictionary. */}
      <PronunciationReview
        open={hints.state.type !== 'idle'}
        state={hints.state}
        bookTitle={hintsTitle}
        onAccept={onHintsAccept}
        onClose={onHintsClose}
      />
    </div>
  )
}
