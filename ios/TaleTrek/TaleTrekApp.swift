import SwiftUI

@main
struct TaleTrekApp: App {
    /// The open-a-book seam: a launch-environment path (UI tests, the
    /// `+`-lane once task 007 lands the library) seeds the reader;
    /// otherwise the placeholder library. State (not a scene branch) so
    /// the reader's back returns to the app surface.
    @State private var openPath: String? =
        ProcessInfo.processInfo.environment["TALETREK_OPEN_BOOK"]

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
            if let openPath {
                ReaderScreen(path: openPath) {
                    self.openPath = nil
                }
            } else {
                ContentView()
            }
        }
    }
}
