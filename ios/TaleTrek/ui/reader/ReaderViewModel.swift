import Foundation
import SwiftUI

/// One rendered chapter — the reader never holds the whole book at once
/// (the per-chapter pattern; whole-book scrolls are the jank cliff).
struct ReaderChapter: Equatable {
    let title: String
    let paragraphs: [String]
}

/// The transport bar's enabled state, derived from the snapshot —
/// bounds facts about *where playback is*, never next/prev decisions.
struct TransportUiState: Equatable {
    var canPlayPause = false
    var playing = false
    var canPrevParagraph = false
    var canNextParagraph = false
    var canPrevChapter = false
    var canNextChapter = false
}

/// The reader screen's render state — SwiftUI renders this, nothing
/// else.
struct ReaderUiState: Equatable {
    var loading = true
    var missing = false
    var bookTitle = ""
    var bookId: String?
    var audioPresent = true
    var chapters: [ReaderChapter] = []
    var renderedChapter = 0
    var follow = true
    var status = FfiPlayerStatus.idle
    var active: FfiParagraphPos?
    var skipped: UInt32 = 0
    /// The outline-jump landing — the pane pulses this paragraph (the
    /// web `tt-nav-target` pattern, adopted cross-app).
    var landing: FfiParagraphPos?
    var transport = TransportUiState()
}

/// Builds the bridge for an opened book — production wires the real
/// engine; tests wire a faked port over the same real kernel.
typealias PlayerHost = (_ book: FfiBook, _ saved: StoredPosition?) -> PlayerBridge

/// The reading surface's state owner: opens the book (restore seeds the
/// starting chapter), renders per-chapter, and runs the sync loop —
/// bridge snapshots in, transport forwards out. Sequencing never lives
/// here; the kernel decides everything. The view model maps, filters
/// (follow/defer scroll policy), and persists positions (the bridge's
/// deduped reports).
@MainActor
final class ReaderViewModel: ObservableObject {
    @Published private(set) var state = ReaderUiState()

    private let openBook: () throws -> FfiBook
    private let store: PositionStore
    private let host: PlayerHost

    private var bridge: PlayerBridge?
    private var lastPara: FfiParagraphPos?
    private var landingClearTask: Task<Void, Never>?

    init(
        openBook: @escaping () throws -> FfiBook,
        store: PositionStore = .standard,
        host: @escaping PlayerHost
    ) {
        self.openBook = openBook
        self.store = store
        self.host = host
        open()
    }

    /// Production convenience: open the bundle at `path`.
    convenience init(path: String, store: PositionStore = .standard) {
        self.init(
            openBook: { try openBook(path: path) },
            store: store,
            host: ReaderViewModel.productionHost(path: path)
        )
    }

    /// The production host: engine + kernel (restored when a position
    /// survives) + bridge, wired.
    private static func productionHost(path: String) -> PlayerHost {
        { book, saved in
            let kernel = saved.map { TrekPlayer.restore(book: book, position: $0.asFfi) }
                ?? TrekPlayer(book: book)
            let engine = AudioEngine(path: path)
            let bridge = PlayerBridge(kernel: kernel, port: engine)
            engine.attach(bridge)
            return bridge
        }
    }

    private func open() {
        Task { @MainActor in
            guard let book = try? openBook() else {
                state.loading = false
                state.missing = true
                return
            }
            let storageKey = positionStorageKey(bookId: book.bookId)
            let saved = store.load(storageKey: storageKey)
            let bridge = host(book, saved)
            self.bridge = bridge
            bridge.onSnapshotChanged = { [weak self] snapshot in
                self?.apply(snapshot)
            }
            bridge.onPositionChanged = { [weak self] position in
                guard let self, let position else { return }
                self.store.save(storageKey: storageKey, StoredPosition(position))
            }
            let snapshot = bridge.snapshot
            state.loading = false
            state.missing = false
            state.bookTitle = book.title
            state.bookId = book.bookId
            state.audioPresent = book.audioPresent
            state.chapters = book.chapters.map {
                ReaderChapter(title: $0.title, paragraphs: $0.paragraphs.map(\.text))
            }
            state.renderedChapter = Int(snapshot.para?.chapter ?? 0)
            apply(snapshot)
        }
    }

    /// A snapshot for this book, mapped into render state.
    private func apply(_ snapshot: FfiStateSnapshot) {
        state.status = snapshot.status
        state.active = snapshot.para
        state.skipped = snapshot.failures.skipped
        deriveTransport()
        // The follow policy: a user scroll defers auto-scroll; the NEXT
        // paragraph re-arms it and the pane tracks the spoken chapter
        // again.
        if let para = snapshot.para, para != lastPara {
            lastPara = para
            state.follow = true
            if state.chapters.indices.contains(Int(para.chapter)) {
                state.renderedChapter = Int(para.chapter)
            }
        }
    }

    /// Enabled-state derivation — bounds facts of the snapshot, nothing
    /// more.
    private func deriveTransport() {
        guard
            let para = state.active,
            state.chapters.indices.contains(Int(para.chapter))
        else {
            state.transport = TransportUiState(canPlayPause: state.audioPresent)
            return
        }
        let audio = state.audioPresent
        let lastChapter = state.chapters.count - 1
        let lastParagraph = UInt32(max(state.chapters[lastChapter].paragraphs.count - 1, 0))
        state.transport = TransportUiState(
            canPlayPause: audio,
            playing: state.status == .playing,
            canPrevParagraph: audio && !(para.chapter == 0 && para.index == 0),
            canNextParagraph: audio && !(Int(para.chapter) == lastChapter && para.index == lastParagraph),
            canPrevChapter: audio && para.chapter > 0,
            canNextChapter: audio && Int(para.chapter) < lastChapter
        )
    }

    /// The user scrolled by hand — defer auto-scroll until the next
    /// paragraph.
    func onUserScrolled() {
        state.follow = false
    }

    /// Click-to-seek: one `SeekToParagraph` forward — the kernel's own
    /// semantics do the rest (idle starts playing there, paused
    /// re-anchors paused, playing jumps).
    func onParagraphTapped(index: Int) {
        bridge?.userSeekToParagraph(chapter: UInt32(state.renderedChapter), index: UInt32(index))
        state.follow = true
    }

    /// Outline selection: seek the kernel to the chapter's first
    /// paragraph, switch the rendered chapter, pulse the landing.
    func jumpToChapter(_ ordinal: Int) {
        guard state.chapters.indices.contains(ordinal) else { return }
        bridge?.userSeekToParagraph(chapter: UInt32(ordinal), index: 0)
        state.renderedChapter = ordinal
        state.follow = true
        state.landing = FfiParagraphPos(chapter: UInt32(ordinal), index: 0)
        landingClearTask?.cancel()
        landingClearTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            if !Task.isCancelled {
                state.landing = nil
            }
        }
    }

    func play() {
        bridge?.userPlay()
    }

    func pause() {
        bridge?.userPause()
    }

    func nextParagraph() {
        bridge?.userNextParagraph()
    }

    func prevParagraph() {
        bridge?.userPrevParagraph()
    }

    func nextChapter() {
        bridge?.userNextChapter()
    }

    func prevChapter() {
        bridge?.userPrevChapter()
    }
}
