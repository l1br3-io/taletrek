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

/// The library: scanned rows (title, author, chapters, audio presence
/// as quiet metadata), swipe-to-delete, the `+` import lane (bundles
/// copied in; sources submitted to the convert controller — no gate,
/// no mode choice), the convert row (phase, x/y, cancel, retry), live
/// search over title + author, per-row export (share/save the bundle,
/// or one gapless merged `.opus`), and the empty state for a fresh
/// install.
struct LibraryScreen: View {
    @ObservedObject var repo: BooksRepository
    @ObservedObject var synth: SynthController
    @ObservedObject var voices: VoiceStore
    let onOpen: (String) -> Void

    @State private var importing = false

    /// The live search's query — ephemeral view state by design (never
    /// persisted, never repo state).
    @State private var query = ""

    /// A prepared artifact handed to the share sheet / Files save.
    private struct ExportItem: Identifiable {
        let url: URL
        let type: UTType
        let defaultName: String

        var id: String { url.path }
    }

    @State private var shareItem: ExportItem?
    @State private var saveItem: ExportItem?

    /// The shelf snapshot the live job started against — the
    /// filling-row disambiguator (a row the job WROTE is filling; a
    /// pre-existing text-only import is not).
    @State private var shelfAtJobStart: Set<String> = []

    /// One rescan per running job — the progressive text bundle lands
    /// mid-run; the row appears, the seal's terminal rescan completes
    /// it.
    @State private var fillScanned = false

    /// The terminal card's dismissal.
    @State private var terminalDismissed = false

    /// Opus has no system UTType — the extension lookup (falling back
    /// to plain data, which the Files app still saves correctly).
    private static let opusType = UTType(filenameExtension: "opus") ?? .data

    /// The shelf under the live query.
    private var rows: [BookShelf] {
        repo.filteredBooks(query)
    }

    /// Whether any scanned row is filling — the convert card's
    /// hide-when-the-row-exists fact.
    private var anyRowFilling: Bool {
        rows.contains { row in
            fillingRowUi(book: row, active: synth.state, preExistingPaths: shelfAtJobStart).filling
        }
    }

    private var convertCardShows: Bool {
        convertCardVisible(
            state: synth.state,
            fillingRowOnShelf: anyRowFilling,
            terminalDismissed: terminalDismissed
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                if repo.state.books.isEmpty && repo.state.skipped == 0 && !convertCardShows {
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
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .automatic),
                prompt: "Search title or author"
            )
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
        .alert(
            "Audio export failed",
            isPresented: Binding(
                get: { repo.lastExportFailure != nil },
                set: { if !$0 { repo.clearExportFailure() } }
            )
        ) {
            Button("OK") {
                repo.clearExportFailure()
            }
        } message: {
            Text(repo.lastExportFailure ?? "")
        }
        .sheet(item: $shareItem) { item in
            ActivityShareSheet(items: [item.url as NSURL])
                .ignoresSafeArea()
        }
        .fileExporter(
            item: Binding(
                get: { saveItem?.url },
                set: { if $0 == nil { saveItem = nil } }
            ),
            contentType: saveItem?.type ?? .data,
            defaultFilename: saveItem?.defaultName
        ) { _ in
            saveItem = nil
        }
        .onAppear {
            synth.onFinished = {
                repo.refresh()
                synth.dismiss()
            }
        }
        .onChange(of: synth.state) { old, new in
            if new.isRunningPhase && !(old?.isRunningPhase ?? false) {
                // The job starts against the shelf as it stands.
                shelfAtJobStart = Set(repo.state.books.map(\.path))
                fillScanned = false
                terminalDismissed = false
            }
            // The progressive text bundle lands mid-run — rescan once
            // per job when synth starts so the row appears; the seal's
            // terminal rescan completes it.
            if new.isSynthPhase && !fillScanned {
                fillScanned = true
                repo.refresh()
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
            if convertCardShows {
                ConvertSection(synth: synth) {
                    terminalDismissed = true
                }
            }
            if repo.state.skipped > 0 {
                Text("\(repo.state.skipped) unreadable bundle(s) skipped")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
            if rows.isEmpty && !repo.state.books.isEmpty {
                Text("No matches for “\(query)”")
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .accessibilityIdentifier("library-no-matches")
            }
            ForEach(rows) { book in
                Button {
                    onOpen(book.path)
                } label: {
                    row(book)
                }
                .accessibilityIdentifier("library-row-\(book.bookId)")
                .swipeActions {
                    if fillingRowUi(
                        book: book, active: synth.state, preExistingPaths: shelfAtJobStart
                    ).filling {
                        Button(role: .destructive) {
                            synth.cancel()
                        } label: {
                            Label("Stop preparing", systemImage: "stop.circle")
                        }
                    }
                    Button(role: .destructive) {
                        repo.delete(book)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
    }

    private func row(_ book: BookShelf) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(book.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.foreground)
                if let fillDetail = fillingRowUi(
                    book: book, active: synth.state, preExistingPaths: shelfAtJobStart
                ).detail {
                    Text(fillDetail)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .accessibilityIdentifier("filling-detail-\(book.bookId)")
                } else {
                    Text(rowDetail(book))
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            if repo.exportingBookId == book.bookId {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Preparing audio")
            }
            exportMenu(book)
        }
    }

    private func rowDetail(_ book: BookShelf) -> String {
        var detail = "\(book.chapterCount) chapter\(book.chapterCount == 1 ? "" : "s")"
            + " · \(book.audioPresent ? "Audio" : "Text only")"
        if let author, !author.isEmpty {
            detail += " · \(author)"
        }
        return detail
    }

    /// The per-row export menu — share/save the bundle as-is, or one
    /// gapless merged `.opus` of the audio (the audio offers exist only
    /// when the book has audio — a text-only export would be a lie).
    private func exportMenu(_ book: BookShelf) -> some View {
        Menu {
            Button {
                shareItem = ExportItem(
                    url: URL(fileURLWithPath: book.path),
                    type: .taletrekBundle,
                    defaultName: "\(book.title).taletrek"
                )
            } label: {
                Label("Share bundle", systemImage: "square.and.arrow.up")
            }
            Button {
                saveItem = ExportItem(
                    url: URL(fileURLWithPath: book.path),
                    type: .taletrekBundle,
                    defaultName: "\(book.title).taletrek"
                )
            } label: {
                Label("Save bundle", systemImage: "arrow.down.doc")
            }
            if book.audioPresent {
                Button {
                    prepareAudio(book) { item in
                        shareItem = item
                    }
                } label: {
                    Label("Share audio", systemImage: "waveform")
                }
                Button {
                    prepareAudio(book) { item in
                        saveItem = item
                    }
                } label: {
                    Label("Save audio", systemImage: "arrow.down.doc.fill")
                }
            }
        } label: {
            Image(systemName: "square.and.arrow.up")
        }
        // The repo's single preparation slot — one remux at a time, no
        // double-taps (the transient Preparing state).
        .disabled(repo.exportingBookId != nil)
        .accessibilityIdentifier("library-export-\(book.bookId)")
    }

    /// The merged-audio preparation: transient Preparing state, then
    /// the artifact off to whichever lane requested it.
    private func prepareAudio(_ book: BookShelf, then: @escaping (ExportItem?) -> Void) {
        repo.prepareAudioExport(book) { url in
            then(url.map {
                ExportItem(url: $0, type: Self.opusType, defaultName: "\(book.title).opus")
            })
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
/// one-tap retry (no partial book; the retry is idempotent). Hidden
/// once the job's filling row is on the shelf (one row per book) —
/// running progress lives there; terminals keep the card until
/// dismissed.
private struct ConvertSection: View {
    @ObservedObject var synth: SynthController
    let onDismiss: () -> Void

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
        case let (chapters?, paragraphs?):
            return "\(chapters) chapters · \(paragraphs) paragraphs"
        case let (chapters?, nil):
            return "\(chapters) chapters"
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
                    onDismiss()
                }
            }
            .font(.caption)
        }
        .accessibilityIdentifier("convert-row")
    }
}

/// The share sheet — `UIActivityViewController` behind a representable
/// (a Menu action can't trigger a `ShareLink` without a button in the
/// tree; this presents the same share sheet ShareLink would).
struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
