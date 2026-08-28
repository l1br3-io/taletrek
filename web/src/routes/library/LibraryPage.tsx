import { X } from 'lucide-react'
import { BundleExportAction } from '../../components/BundleExportAction'
import { BundleImportButton } from '../../components/BundleImportButton'
import { useDatasource } from '../../context/datasource'
import { AiStatusChip } from './AiStatusChip'
import { FeatureUnavailableSheet } from './FeatureUnavailableSheet'
import { LibraryList } from './LibraryList'
import { OutlineSheet } from './OutlineSheet'
import { PronunciationReview } from './PronunciationReview'
import { SynthVoiceSheet } from './SynthVoiceSheet'
import { UploadBookModal } from './UploadBookModal'
import { UploadButton } from './UploadButton'
import { useLibraryState } from './useLibraryState'

export function Library() {
  const { mode, synth } = useDatasource()
  const hosted = mode === 'server'
  const {
    ai,
    online,
    engine,
    aiUsable,
    aiUnusableReason,
    unavailableFeature,
    onUnavailableFeatureClose,
    transform,
    outline,
    hints,
    list,
    refresh,
    runCtx,
    hintsTitle,
    parseState,
    uploadBusy,
    runInitialOps,
    handleSelect,
    onRunCancel,
    onRunGenerate,
    handleRename,
    handleTransform,
    outlineBookId,
    outlineFormat,
    handleOutline,
    handleOutlineAi,
    handleOutlinePdf,
    handleOutlineClose,
    handlePronunciation,
    onHintsAccept,
    onHintsClose,
    handleDelete,
    handleResynthesize,
    synthStatusFor,
    synthVoiceTarget,
    startSynthWithVoice,
    onSynthVoiceClose,
    exportTarget,
    handleExportBundle,
    handleExportClose,
    dismissParseError,
    synthesizeOnUpload,
    navigate,
  } = useLibraryState()

  // AI menu items are visible whenever AI is enabled — even if not usable right
  // now. Clicking an unusable item opens the explanatory sheet (the handler
  // inside `useLibraryState` re-routes via `aiUnusableReason`). `BookCard`
  // shows an amber dot next to flagged items so the state is legible at a
  // glance rather than discoverable only by clicking. `aiUnusableReason`
  // flows down so the tooltip can name the specific blocker.
  const aiMenuItems = ai.enabled
    ? { onTransform: handleTransform, onPronunciation: handlePronunciation }
    : {}

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <span className="text-accent" aria-hidden>
            ❯
          </span>
          Library
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <UploadButton onSelect={handleSelect} disabled={uploadBusy} />
          {/* Bundle import reads local IDB — a local-mode affordance (T16). */}
          {!hosted && (
            <BundleImportButton onImported={() => void refresh()} disabled={uploadBusy} />
          )}
        </div>
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
        <>
          {aiUnusableReason && (
            <AiStatusChip
              reason={aiUnusableReason}
              onOpenSettings={() => navigate('/settings#ai')}
            />
          )}
          <LibraryList
            books={list.books}
            onOpen={(id) => navigate(`/reader/${id}`)}
            onDelete={handleDelete}
            {...aiMenuItems}
            onOutline={hosted ? undefined : handleOutline}
            onResynthesize={synthesizeOnUpload !== 'off' ? handleResynthesize : undefined}
            onResume={(id) => void synth.resume(id)}
            onRename={hosted ? undefined : handleRename}
            onExportBundle={hosted ? undefined : (id) => void handleExportBundle(id)}
            synthStatusFor={hosted ? synthStatusFor : undefined}
            aiUsable={aiUsable}
            aiUnusableReason={aiUnusableReason}
          />
        </>
      )}

      {/* Hosted per-book Synthesize: pick the server voice first (T16). */}
      <SynthVoiceSheet
        target={synthVoiceTarget}
        onSelect={startSynthWithVoice}
        onClose={onSynthVoiceClose}
      />

      {/* Process modal: always shown after upload when AI is enabled (opt-in skip).
          Also used for Reprocess (re-parse original → transform). Cancel/Close
          on post-upload proceeds to synth; on reprocess stays in library. */}
      <UploadBookModal
        open={runCtx !== null}
        state={transform.state}
        defs={ai.transformDefs}
        initialOps={runInitialOps}
        onGenerate={onRunGenerate}
        onCancel={onRunCancel}
        online={online}
      />

      <OutlineSheet
        open={outlineBookId !== null}
        state={outline.state}
        format={outlineFormat}
        online={online}
        onUsePdfOutline={() => void handleOutlinePdf()}
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

      {/* Explanatory sheet shown when the user clicks an AI menu item while AI
          is enabled but not usable. Tells them what's missing and offers a
          deep-link to Settings → AI. Suppress the Settings button when the
          reason is `offline` (reconnecting is the fix, not a config change). */}
      {unavailableFeature && aiUnusableReason && (
        <FeatureUnavailableSheet
          open
          feature={unavailableFeature.feature}
          reason={aiUnusableReason}
          onClose={onUnavailableFeatureClose}
          onOpenSettings={() => {
            onUnavailableFeatureClose()
            navigate('/settings#ai')
          }}
        />
      )}
    </div>
  )
}
