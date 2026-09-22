import Combine
import Foundation

/// One library row — manifest display data, nothing else.
struct BookShelf: Equatable, Identifiable {
    let bookId: String
    let title: String
    let chapterCount: Int
    let audioPresent: Bool
    let path: String

    var id: String { bookId }
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
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("books")
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
}
