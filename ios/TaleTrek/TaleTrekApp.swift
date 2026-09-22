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

    /// The one convert slot — sources picked or shared go straight to
    /// the full audio job (instant-listen).
    @StateObject private var synth = SynthController()

    @Environment(\.scenePhase) private var scenePhase

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
                    LibraryScreen(repo: library, synth: synth) { path in
                        self.openPath = path
                    }
                }
            }
            // Files/Mail/Safari hand documents over: bundles copy into
            // the scan root; sources submit the full audio job — no
            // gate, no badge.
            .onOpenURL { url in
                openShared(url)
            }
            // Foreground-only conversion: backgrounding arms the grace;
            // expiry cancels cleanly into the retryable Interrupted.
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background:
                    synth.noteBackgrounded()
                case .active:
                    synth.noteForegrounded()
                case .inactive:
                    break
                @unknown default:
                    break
                }
            }
        }
    }

    private func openShared(_ url: URL) {
        if url.pathExtension.lowercased() == "taletrek" {
            _ = library.importFrom(url)
        } else {
            _ = synth.submit(
                source: url,
                dirs: .standard(booksDir: URL(fileURLWithPath: library.booksDirPath))
            )
        }
    }
}
