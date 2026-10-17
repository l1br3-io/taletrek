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

    /// The optional voice override — nil = the kernel default.
    @StateObject private var voices = VoiceStore.standard

    @Environment(\.scenePhase) private var scenePhase

    init() {
        // The UI tests' clean-slate hook: drop any persisted positions
        // before anything opens a book (must precede the store's lazy
        // first access).
        if ProcessInfo.processInfo.environment["TALETREK_RESET_POSITIONS"] != nil {
            PositionStore.resetStandard()
        }
        // The segment store, wired at launch (the submit path
        // re-registers per job — this is the belt-and-braces first
        // path; store-aware reads work before any job runs).
        setSegmentStore(dir: ImportDirs.standardStoreDir)
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let openPath {
                    ReaderScreen(
                        path: openPath,
                        jobAlive: { [weak synth] in synth?.state.isRunningPhase ?? false },
                        onAnchorMoved: { [weak synth] anchor in
                            synth?.reanchor(anchor)
                        },
                        onResumePreparing: { [weak synth] in
                            guard let synth else { return }
                            if synth.state.isRetryablePhase {
                                _ = synth.retry()
                            } else {
                                synth.resumePending(
                                    booksDir: URL(fileURLWithPath: library.booksDirPath)
                                )
                            }
                        },
                        onBack: {
                            self.openPath = nil
                        }
                    )
                } else {
                    LibraryScreen(repo: library, synth: synth, voices: voices) { path in
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
            // A pending import surviving process death re-submits here
            // (the segment store makes resume cheap — done keys skip).
            .onAppear {
                synth.resumePending(booksDir: URL(fileURLWithPath: library.booksDirPath))
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
                dirs: .standard(booksDir: URL(fileURLWithPath: library.booksDirPath)),
                voiceId: voices.selected
            )
        }
    }
}
