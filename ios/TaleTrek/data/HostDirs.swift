import Foundation

/// The app's host directories, one env-aware seam — production reads
/// `Application Support`; the fresh-run e2e points everything at a
/// throwaway root (`TALETREK_CACHE_ROOT`) so the story it proves is a
/// true fresh install without wiping the machine's shared caches
/// (Android's `FirstRunTest` isolation, transposed; the same seam
/// pattern as `TALETREK_OPEN_BOOK`/`TALETREK_BOOKS_DIR`).
enum HostDirs {
    /// The support root: Application Support, or the fresh-run override.
    static var supportRoot: URL {
        if let root = ProcessInfo.processInfo.environment["TALETREK_CACHE_ROOT"] {
            return URL(fileURLWithPath: root)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    /// The voice cache (bit-for-bit cross-app layout in production).
    static var voicesDir: URL {
        supportRoot.appendingPathComponent("voices")
    }

    /// The espeak-ng-data dir the pipeline ensures on first convert.
    static var espeakDir: URL {
        supportRoot.appendingPathComponent("espeak-ng-data")
    }
}
