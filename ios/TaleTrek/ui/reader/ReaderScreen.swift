import SwiftUI

/// The reading surface: one chapter at a time in a lazy stack (the
/// per-chapter pattern), the spoken paragraph highlighted in an
/// identical frame (the highlight fills a frame that's always there, so
/// it never reflows), playback auto-scrolling it into view unless the
/// user is scrolling (drags defer; the next paragraph resumes), and
/// taps on narrated paragraphs seeking there — one event, kernel
/// semantics. The toolbar carries back + book title + the Chapters
/// button on every chapter page (the locked reader-page design).
struct ReaderScreen: View {
    @StateObject private var viewModel: ReaderViewModel
    let onBack: () -> Void

    @State private var outlineOpen = false

    init(path: String, store: PositionStore = .standard, onBack: @escaping () -> Void) {
        _viewModel = StateObject(wrappedValue: ReaderViewModel(path: path, store: store))
        self.onBack = onBack
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.line)
            content
        }
        .background(Theme.background)
        .sheet(isPresented: $outlineOpen) {
            if viewModel.state.chapters.indices.contains(viewModel.state.renderedChapter) {
                OutlineSheet(
                    chapters: viewModel.state.chapters,
                    current: viewModel.state.renderedChapter
                ) { ordinal in
                    viewModel.jumpToChapter(ordinal)
                }
            }
        }
    }

    /// Back (leading) + book title (center) + Chapters (trailing) — on
    /// every chapter page; disabled only when the chapter list is empty.
    private var header: some View {
        HStack {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 40, height: 40)
            }
            .accessibilityLabel("Back to library")
            Spacer()
            Text(viewModel.state.bookTitle.isEmpty ? "Reader" : viewModel.state.bookTitle)
                .font(.headline)
                .foregroundStyle(Theme.foreground)
                .lineLimit(1)
                .truncationMode(.tail)
                .accessibilityIdentifier("reader-title")
            Spacer()
            Button {
                outlineOpen = true
            } label: {
                Image(systemName: "list.bullet")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 40, height: 40)
            }
            .disabled(viewModel.state.chapters.isEmpty)
            .accessibilityLabel("Chapters")
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .background(Theme.background)
    }

    @ViewBuilder
    private var content: some View {
        let state = viewModel.state
        if state.loading {
            Text("Opening book…")
                .font(.body)
                .foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if state.missing {
            VStack(spacing: 12) {
                Text("This book couldn't be opened — it may be damaged or removed.")
                    .font(.body)
                    .foregroundStyle(Theme.foreground)
                    .multilineTextAlignment(.center)
                Button("Back to library", action: onBack)
                    .buttonStyle(.bordered)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                chapterPane(state)
                if state.skipped > 0 {
                    Text(
                        "\(state.skipped) segment\(state.skipped == 1 ? "" : "s") skipped — continuing"
                    )
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                    .padding(.top, 4)
                    .accessibilityIdentifier("skip-line")
                }
                TransportBar(
                    state: state.transport,
                    onPlayPause: state.transport.playing ? viewModel.pause : viewModel.play,
                    onPrevParagraph: viewModel.prevParagraph,
                    onNextParagraph: viewModel.nextParagraph,
                    onPrevChapter: viewModel.prevChapter,
                    onNextChapter: viewModel.nextChapter
                )
            }
        }
    }

    /// The per-chapter text pane: header + one framed paragraph per row,
    /// auto-scrolling the spoken paragraph into view while following.
    private func chapterPane(_ state: ReaderUiState) -> some View {
        let chapter = state.chapters[state.renderedChapter]
        let activeIndex: Int? =
            (state.active.map(\.chapter) == UInt32(state.renderedChapter))
            ? state.active.map { Int($0.index) } : nil
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    Text(chapter.title)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Theme.foreground)
                        .padding(.bottom, 12)
                        .padding(.top, 8)
                        .accessibilityIdentifier("chapter-title")
                    ForEach(chapter.paragraphs.indices, id: \.self) { index in
                        ParagraphRow(
                            text: chapter.paragraphs[index],
                            isActive: index == activeIndex,
                            isLanding: state.landing == FfiParagraphPos(
                                chapter: UInt32(state.renderedChapter), index: UInt32(index)
                            ),
                            narrated: state.audioPresent
                        ) {
                            viewModel.onParagraphTapped(index: index)
                        }
                        .id(index)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            }
            // Only touch drags defer following — programmatic scrolls
            // from scrollTo never register as drag gestures, so
            // auto-scroll cannot pause itself.
            .simultaneousGesture(
                DragGesture().onChanged { _ in viewModel.onUserScrolled() }
            )
            .onChange(of: state.active) { _, active in
                guard state.follow, let active else { return }
                if Int(active.chapter) == state.renderedChapter {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        proxy.scrollTo(Int(active.index), anchor: .center)
                    }
                }
            }
            .onChange(of: state.renderedChapter) { _, _ in
                guard state.follow else { return }
                withAnimation(.easeInOut(duration: 0.25)) {
                    proxy.scrollTo(0, anchor: .top)
                }
            }
        }
    }
}

/// One paragraph row — the identical frame: fill + padding exist whether
/// active or not, so the moving highlight never reflows the text. The
/// landing pulse (outline jumps) rings the paragraph with an accent
/// stroke that fades (the web `tt-nav-target` pattern).
private struct ParagraphRow: View {
    let text: String
    let isActive: Bool
    let isLanding: Bool
    let narrated: Bool
    let onTap: () -> Void

    @State private var landingVisible = false

    var body: some View {
        Text(text)
            .font(.body)
            .foregroundStyle(isActive ? Theme.accent : Theme.foreground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isActive ? Theme.accentWash : Color.clear)
            )
            .overlay {
                if landingVisible {
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Theme.accent, lineWidth: 2)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                if narrated {
                    onTap()
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                isActive ? "Spoken paragraph: \(text)" : "Paragraph: \(text)"
            )
            .accessibilityIdentifier(isActive ? "spoken-paragraph" : "paragraph")
            .task(id: isLanding) {
                // The pulse: ring in, fade out, clear — pure view state.
                if isLanding {
                    landingVisible = true
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    withAnimation(.easeOut(duration: 0.6)) {
                        landingVisible = false
                    }
                }
            }
    }
}
