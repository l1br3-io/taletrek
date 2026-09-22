import SwiftUI

@main
struct TaleTrekApp: App {
    /// The open-a-book seam: a launch-environment path (UI tests) or a
    /// library row hands the reader a bundle; nil shows the library.
    /// State (not a scene branch) so the reader's back returns here.
    @State private var openPath: String? =
        ProcessInfo.processInfo.environment["TALETREK_OPEN_BOOK"]

    /// The one library for the scene — the scan root and the open-in
    /// import lane both land here.
    @StateObject private var library = BooksRepository()

    init() {
        // The UI tests' clean-slate hook: drop any persisted positions
        // before anything opens a book (must precede the store's lazy
        // first access).
        if ProcessInfo.processInfo.environment["TALETREK_RESET_POSITIONS"] != nil {
            PositionStore.resetStandard()
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let openPath {
                    ReaderScreen(path: openPath) {
                        self.openPath = nil
                    }
                } else {
                    LibraryScreen(repo: library) { path in
                        self.openPath = path
                    }
                }
            }
            // Files/Mail/Safari hand a .taletrek straight over: a copy
            // into the scan root and a rescan — the row is waiting when
            // the reader closes (no gate, no badge).
            .onOpenURL { url in
                _ = library.importFrom(url)
            }
        }
    }
}
