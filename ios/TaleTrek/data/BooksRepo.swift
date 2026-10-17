import Combine
import Foundation

/// One library row — manifest display data, nothing else.
struct BookShelf: Equatable, Identifiable {
    let bookId: String
    let title: String
    let author: String?
    let chapterCount: Int
    let audioPresent: Bool
    let path: String

    var id: String { bookId }

    /// The live search's match — case-insensitive substring over title
    /// + author (the `android-export-search` parity set). Pure so the
    /// derivation tests without a view.
    func matches(query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        let needle = trimmed.lowercased()
        if title.lowercased().contains(needle) { return true }
        if let author, author.lowercased().contains(needle) { return true }
        return false
    }
}

/// The scanned library: good books plus a count of unreadable ones.
struct LibraryState: Equatable {
    var books: [BookShelf] = []
    var skipped = 0
}

/// What an import attempt did — failures surface in the UI, never
/// crash it.
enum ImportOutcome: Equatable {
    case imported(BookShelf)
    case rejected(String)
}

/// The library: a directory scan of the bundle files in
/// `Application Support/books/` read through the kernel (`openBook` —
/// manifest + text; audio entries are never touched). No database —
/// the list *is* the manifests (Android's `BooksRepository`
/// transposed). A bad file is a skipped count, never a dead library.
@MainActor
final class BooksRepository: ObservableObject {
    @Published private(set) var state = LibraryState()

    /// The last import's failure, when it failed — the alert's model
    /// (the open-in lane has no button to hang it on).
    @Published private(set) var lastImportFailure: String?

    private let booksDir: URL
    private let positions: PositionStore

    /// The production scan root — the UI tests' env override rides the
    /// same seam the reader's `TALETREK_OPEN_BOOK` uses. Nonisolated:
    /// the default-parameter reference below is evaluated outside the
    /// actor (and the helper only touches ProcessInfo/FileManager).
    nonisolated static var standardBooksDir: URL {
        if let override = ProcessInfo.processInfo.environment["TALETREK_BOOKS_DIR"] {
            return URL(fileURLWithPath: override)
        }
        return HostDirs.supportRoot.appendingPathComponent("books")
    }

    init(
        booksDir: URL = BooksRepository.standardBooksDir,
        positions: PositionStore = .standard
    ) {
        self.booksDir = booksDir
        self.positions = positions
        refresh()
    }

    /// The scan root as a path (the convert request's `booksDir`).
    var booksDirPath: String {
        booksDir.path
    }

    /// Rescan `books/` (the initial load rides init).
    func refresh() {
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: booksDir,
            includingPropertiesForKeys: [.isRegularFileKey]
        )) ?? []
        let files = contents
            .filter { url in
                url.pathExtension == "taletrek"
                    && (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        var books: [BookShelf] = []
        for file in files {
            // Validation IS the kernel read: an unreadable manifest is
            // a skipped row, never a dead library.
            if let book = try? openBook(path: file.path) {
                books.append(
                    BookShelf(
                        bookId: book.bookId,
                        title: book.title,
                        author: book.author,
                        chapterCount: book.chapters.count,
                        audioPresent: book.audioPresent,
                        path: file.path
                    )
                )
            }
        }
        books.sort { $0.title.lowercased() < $1.title.lowercased() }
        state = LibraryState(books: books, skipped: files.count - books.count)
    }

    /// The shelf under the live search's (ephemeral) query — the query
    /// lives in view state, never here.
    func filteredBooks(_ query: String) -> [BookShelf] {
        state.books.filter { $0.matches(query: query) }
    }

    /// Copy-on-import a picked (fileImporter) or opened (open-in)
    /// bundle into the scan root. Staged through a temp file so a
    /// rejected import leaves no residue; validation is `openBook` on
    /// the staged copy; a same-id re-import overwrites by design —
    /// deterministic ids mean one entry, never two, and the position
    /// under that id survives.
    func importFrom(_ url: URL) -> ImportOutcome {
        // Picked documents are security-scoped; open-in copies are not
        // (the bool says which).
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                url.stopAccessingSecurityScopedResource()
            }
        }
        do {
            try FileManager.default.createDirectory(at: booksDir, withIntermediateDirectories: true)
            let staged = booksDir.appendingPathComponent("import-\(UUID().uuidString).tmp")
            try FileManager.default.copyItem(at: url, to: staged)
            do {
                let book = try openBook(path: staged.path)
                let dest = booksDir.appendingPathComponent("\(book.bookId).taletrek")
                if FileManager.default.fileExists(atPath: dest.path) {
                    try FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.moveItem(at: staged, to: dest)
                lastImportFailure = nil
                refresh()
                return .imported(
                    BookShelf(
                        bookId: book.bookId,
                        title: book.title,
                        author: book.author,
                        chapterCount: book.chapters.count,
                        audioPresent: book.audioPresent,
                        path: dest.path
                    )
                )
            } catch {
                try? FileManager.default.removeItem(at: staged)
                lastImportFailure = error.localizedDescription
                return .rejected(error.localizedDescription)
            }
        } catch {
            lastImportFailure = error.localizedDescription
            return .rejected(error.localizedDescription)
        }
    }

    func clearImportFailure() {
        lastImportFailure = nil
    }

    /// Delete a book's file and its orphaned position (the position
    /// clear is best-effort — it never blocks the delete).
    func delete(_ book: BookShelf) {
        try? FileManager.default.removeItem(atPath: book.path)
        positions.clear(storageKey: positionStorageKey(bookId: book.bookId))
        refresh()
    }

    // --- export (android-export-search parity) ----------------------------

    /// The book whose merged audio is being prepared right now — the
    /// transient "Preparing…" state that blocks double-taps.
    @Published private(set) var exportingBookId: String?

    /// The last audio-export failure, when one failed (the alert's
    /// model).
    @Published private(set) var lastExportFailure: String?

    /// `Caches/exports/` — merged-audio temp files, left for the OS
    /// (segments and re-exports are cheap; Android's `<cacheDir>`
    /// stance).
    nonisolated static var exportsDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("exports", isDirectory: true)
    }

    /// Merge the book's audio into one gapless `.opus` (the kernel's
    /// lossless remux) under `Caches/exports/` and hand it to the
    /// completion on the main actor — `nil` on failure (the typed
    /// failure lands in `lastExportFailure`). One preparation at a
    /// time; the remux runs off-main.
    func prepareAudioExport(_ book: BookShelf, completion: @escaping (URL?) -> Void) {
        guard exportingBookId == nil else { return }
        exportingBookId = book.bookId
        lastExportFailure = nil
        let bundlePath = book.path
        let dest = Self.exportsDir.appendingPathComponent("\(book.bookId).opus")
        Task.detached(priority: .userInitiated) { [weak self] in
            try? FileManager.default.createDirectory(
                at: Self.exportsDir, withIntermediateDirectories: true
            )
            // A stale export from an earlier run of this book is not a
            // cache hit — the remux is cheap, the file must be true.
            try? FileManager.default.removeItem(at: dest)
            do {
                _ = try exportMergedAudio(bundlePath: bundlePath, destPath: dest.path)
                await MainActor.run {
                    self?.exportingBookId = nil
                    completion(dest)
                }
            } catch {
                await MainActor.run {
                    self?.exportingBookId = nil
                    self?.lastExportFailure = error.localizedDescription
                    completion(nil)
                }
            }
        }
    }

    func clearExportFailure() {
        lastExportFailure = nil
    }
}

// --- filling rows (android-export-search parity, post-ship tuning) ----------

/// The library row's filling state — pure derivation (the rendering is
/// dumb). A text-only row is "preparing audio" exactly when a live job
/// wrote it during this run (it appeared after the shelf snapshot the
/// job started against); desktop-made text-only imports keep the
/// neutral row.
struct FillingRowUi: Equatable {
    var filling = false
    var detail: String?
}

func fillingRowUi(
    book: BookShelf, active: SynthUiState?, preExistingPaths: Set<String>
) -> FillingRowUi {
    if book.audioPresent { return FillingRowUi() }
    guard let active, active.isRunningPhase else { return FillingRowUi() }
    if preExistingPaths.contains(book.path) { return FillingRowUi() }
    guard let counts = active.paragraphCounts, counts.total > 0 else {
        return FillingRowUi(filling: true, detail: nil)
    }
    return FillingRowUi(
        filling: true,
        detail: "Preparing audio · \(min(counts.done, counts.total)) of \(counts.total) paragraphs"
    )
}

/// Whether the pinned convert card is visible — one row per book: once
/// the job's filling row is on the shelf, running progress lives on the
/// row and the card hides (the row's menu carries cancel). Before the
/// row exists (parse, voice download — first run) the card is the only
/// feedback. Terminal states keep the card until dismissed.
func convertCardVisible(
    state: SynthUiState?, fillingRowOnShelf: Bool, terminalDismissed: Bool
) -> Bool {
    guard let state, state != .idle else { return false }
    if state.isRunningPhase {
        return !fillingRowOnShelf
    }
    return !terminalDismissed
}
