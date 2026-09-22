import SwiftUI
import UniformTypeIdentifiers

/// The TaleTrek bundle's type identity — declared in Info.plist
/// (`UTExportedTypeDeclarations` + `CFBundleDocumentTypes`), reached in
/// code for the fileImporter's filter.
extension UTType {
    static let taletrekBundle = UTType(exportedAs: "dev.l1br3.taletrek")

    /// The six source formats the convert lane accepts alongside
    /// bundles (instant-listen: a picked source submits the full audio
    /// job immediately). epub/docx have no UTType statics — registry
    /// lookups by identifier (system-declared).
    static let sourceDocuments: [UTType] = [
        UTType("org.idpf.epub-container"),
        UTType("org.openxmlformats.wordprocessingml.document"),
        .pdf,
        .plainText,
        .html,
        UTType("net.daringfireball.markdown"),
    ].compactMap { $0 }
}

/// The library: scanned rows (title, chapters, audio presence as quiet
/// metadata), swipe-to-delete, the `+` import lane (bundles copied in;
/// sources submitted to the convert controller — no gate, no mode
/// choice), the convert row (phase, x/y, cancel, retry), and the empty
/// state for a fresh install.
struct LibraryScreen: View {
    @ObservedObject var repo: BooksRepository
    @ObservedObject var synth: SynthController
    @ObservedObject var voices: VoiceStore
    let onOpen: (String) -> Void

    @State private var importing = false

    var body: some View {
        NavigationStack {
            Group {
                if repo.state.books.isEmpty && repo.state.skipped == 0 && synth.state == .idle {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("TaleTrek")
            .toolbar {
                Button {
                    importing = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Import book")
                NavigationLink {
                    VoicesScreen(store: voices)
                } label: {
                    Image(systemName: "waveform")
                }
                .accessibilityLabel("Voices")
            }
        }
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.taletrekBundle] + UTType.sourceDocuments
        ) { result in
            if case let .success(url) = result {
                importPicked(url)
            }
        }
        .alert(
            "Import failed",
            isPresented: Binding(
                get: { repo.lastImportFailure != nil },
                set: { if !$0 { repo.clearImportFailure() } }
            )
        ) {
            Button("OK") {
                repo.clearImportFailure()
            }
        } message: {
            Text(repo.lastImportFailure ?? "")
        }
        .onAppear {
            synth.onFinished = {
                repo.refresh()
                synth.dismiss()
            }
        }
    }

    /// The one lane: bundles copy in, sources convert — full audio job,
    /// immediately, no decisions.
    private func importPicked(_ url: URL) {
        if url.pathExtension.lowercased() == "taletrek" {
            _ = repo.importFrom(url)
        } else {
            _ = synth.submit(
                source: url,
                dirs: .standard(booksDir: URL(fileURLWithPath: repo.booksDirPath)),
                voiceId: voices.selected
            )
        }
    }

    private var list: some View {
        List {
            if synth.state != .idle {
                ConvertSection(synth: synth)
            }
            if repo.state.skipped > 0 {
                Text("\(repo.state.skipped) unreadable bundle(s) skipped")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
            ForEach(repo.state.books) { book in
                Button {
                    onOpen(book.path)
                } label: {
                    row(book)
                }
                .accessibilityIdentifier("library-row-\(book.bookId)")
            }
            .onDelete { offsets in
                for index in offsets {
                    repo.delete(repo.state.books[index])
                }
            }
        }
    }

    private func row(_ book: BookShelf) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(book.title)
                .font(.body.weight(.medium))
                .foregroundStyle(Theme.foreground)
            Text(
                "\(book.chapterCount) chapter\(book.chapterCount == 1 ? "" : "s")"
                    + " · \(book.audioPresent ? "Audio" : "Text only")"
            )
            .font(.caption)
            .foregroundStyle(Theme.muted)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "book")
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(Theme.muted)
            Text("No books yet")
                .font(.headline)
                .foregroundStyle(Theme.foreground)
            Text("Import a .taletrek bundle or a document — it converts to audio right here.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            Button("Import book") {
                importing = true
            }
                .buttonStyle(.bordered)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // A plain VStack is not an accessibility element — the
        // identifier would never surface to XCUITest. `.contain` makes
        // the empty state a real (still per-child accessible) element.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("library-empty")
    }
}

/// The convert row — one job slot, rendered by phase. Foreground-only
/// by design: backgrounding mid-synth surfaces `.interrupted` with a
/// one-tap retry (no partial book; the retry is idempotent).
private struct ConvertSection: View {
    @ObservedObject var synth: SynthController

    var body: some View {
        Section {
            switch synth.state {
            case .idle:
                EmptyView()
            case let .preparing(chapters, paragraphs):
                row(
                    title: "Reading document…",
                    detail: preparingDetail(chapters: chapters, paragraphs: paragraphs),
                    running: true
                )
            case let .downloadingVoice(done, total):
                row(
                    title: "Downloading voice…",
                    detail: total > 0
                        ? "\(megabytes(done)) of \(megabytes(total))"
                        : "\(megabytes(done))",
                    running: true
                )
            case let .synthesizing(done, total):
                row(
                    title: "Converting to audio…",
                    detail: total > 0 ? "paragraph \(min(done, total)) of \(total)" : "starting…",
                    running: true
                )
            case .writing:
                row(title: "Writing the book…", detail: nil, running: true)
            case .done:
                row(title: "Added to library", detail: nil, running: false)
            case let .failed(kind, message):
                terminal(
                    title: "Conversion failed",
                    detail: "\(kind): \(message)",
                    retryable: true
                )
            case .cancelled:
                terminal(
                    title: "Cancelled",
                    detail: "No partial book was kept.",
                    retryable: false
                )
            case .interrupted:
                terminal(
                    title: "Interrupted",
                    detail: "Conversion needs the app in the foreground — tap retry to resume.",
                    retryable: true
                )
            }
        }
    }

    private func preparingDetail(chapters: UInt32?, paragraphs: UInt32?) -> String? {
        switch (chapters, paragraphs) {
        case let (c?, p?):
            return "\(c) chapters · \(p) paragraphs"
        case let (c?, nil):
            return "\(c) chapters"
        default:
            return nil
        }
    }

    private func megabytes(_ bytes: UInt64) -> String {
        String(format: "%.1f MB", Double(bytes) / 1_000_000)
    }

    private func row(title: String, detail: String?, running: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.foreground)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            if running {
                Button("Cancel") {
                    synth.cancel()
                }
                .font(.caption)
                .accessibilityIdentifier("convert-cancel")
            }
        }
        .accessibilityIdentifier("convert-row")
    }

    private func terminal(title: String, detail: String, retryable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.body.weight(.medium))
                .foregroundStyle(Theme.foreground)
            Text(detail)
                .font(.caption)
                .foregroundStyle(Theme.muted)
            HStack {
                if retryable {
                    Button("Retry") {
                        _ = synth.retry()
                    }
                    .accessibilityIdentifier("convert-retry")
                }
                Button("Dismiss") {
                    synth.dismiss()
                }
            }
            .font(.caption)
        }
        .accessibilityIdentifier("convert-row")
    }
}
