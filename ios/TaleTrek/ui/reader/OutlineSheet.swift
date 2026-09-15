import SwiftUI

/// The outline, per the locked reader-page design (spec § Reader page):
/// a detent sheet — the iOS-idiomatic bottom sheet (Android's
/// `ModalBottomSheet` equivalent; drag to dismiss) — headed by the
/// honest kernel currency ("Chapter *n* of *N*"; no durations, no
/// sub-headings — manifest v1 is chapter-flat), rows carrying a muted
/// number prefix + title, the current chapter accented with a trailing
/// "Now reading" marker, the list opening pre-scrolled to the current
/// chapter, and a tap jumping (kernel first-paragraph seek) + dismissing
/// — the landing paragraph then pulses in the pane.
struct OutlineSheet: View {
    let chapters: [ReaderChapter]
    let current: Int
    let onJump: (Int) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Text("Chapter \(current + 1) of \(chapters.count)")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                        .padding(.bottom, 8)
                        .accessibilityIdentifier("outline-header")
                    ForEach(chapters.indices, id: \.self) { index in
                        row(index)
                    }
                    // Clearance above the home indicator at .medium.
                    Color.clear.frame(height: 24)
                }
            }
            .onAppear {
                // Pre-scrolled, centered anchor — cheap and decisive on
                // long TOCs (the Books/Kindle pattern).
                proxy.scrollTo(current, anchor: .center)
            }
        }
        .background(Theme.background)
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func row(_ index: Int) -> some View {
        let isCurrent = index == current
        Button {
            onJump(index)
        } label: {
            HStack(spacing: 12) {
                Text("\(index + 1)")
                    .font(.body.monospacedDigit())
                    .foregroundStyle(Theme.muted)
                    .frame(width: 34, alignment: .trailing)
                Text(chapters[index].title)
                    .font(.body.weight(isCurrent ? .semibold : .regular))
                    .foregroundStyle(isCurrent ? Theme.accent : Theme.foreground)
                    .multilineTextAlignment(.leading)
                if isCurrent {
                    Spacer(minLength: 8)
                    Text("Now reading")
                        .font(.caption)
                        .foregroundStyle(Theme.accent)
                } else {
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .id(index)
        .accessibilityIdentifier("chapter-row-\(index)")
    }
}
