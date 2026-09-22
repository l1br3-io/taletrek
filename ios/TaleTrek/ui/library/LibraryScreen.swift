import SwiftUI
import UniformTypeIdentifiers

/// The TaleTrek bundle's type identity — declared in Info.plist
/// (`UTExportedTypeDeclarations` + `CFBundleDocumentTypes`), reached in
/// code for the fileImporter's filter.
extension UTType {
    static let taletrekBundle = UTType(exportedAs: "dev.l1br3.taletrek")
}

/// The library: scanned rows (title, chapters, audio presence as quiet
/// metadata), swipe-to-delete, the `+` import lane (fileImporter — a
/// `.taletrek` import is a copy and a rescan, nothing else), and the
/// empty state for a fresh install. Opening a row hands the path to
/// the reader; back returns here.
struct LibraryScreen: View {
    @ObservedObject var repo: BooksRepository
    let onOpen: (String) -> Void

    @State private var importing = false

    var body: some View {
        NavigationStack {
            Group {
                if repo.state.books.isEmpty && repo.state.skipped == 0 {
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
            }
        }
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.taletrekBundle]
        ) { result in
            if case let .success(url) = result {
                _ = repo.importFrom(url)
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
    }

    private var list: some View {
        List {
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
            Text("Import a .taletrek bundle to start listening.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
            Button("Import book") {
                importing = true
            }
                .buttonStyle(.bordered)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("library-empty")
    }
}
