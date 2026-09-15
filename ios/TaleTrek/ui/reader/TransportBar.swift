import SwiftUI

/// The transport bar: six forwards, zero decisions. Every button is a
/// one-line event out; enabled/playing state arrives derived from the
/// kernel's snapshot. Text-only books render it inert with the
/// explanatory hint (parity with desktop/web/Android).
struct TransportBar: View {
    let state: TransportUiState
    let onPlayPause: () -> Void
    let onPrevParagraph: () -> Void
    let onNextParagraph: () -> Void
    let onPrevChapter: () -> Void
    let onNextChapter: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                TransportButton(
                    systemImage: "backward.end.fill",
                    label: "Previous chapter",
                    enabled: state.canPrevChapter,
                    action: onPrevChapter
                )
                TransportButton(
                    systemImage: "chevron.left",
                    label: "Previous paragraph",
                    enabled: state.canPrevParagraph,
                    action: onPrevParagraph
                )
                TransportButton(
                    systemImage: state.playing ? "pause.fill" : "play.fill",
                    label: state.playing ? "Pause" : "Play",
                    enabled: state.canPlayPause,
                    action: onPlayPause,
                    identifier: "transport-play"
                )
                TransportButton(
                    systemImage: "chevron.right",
                    label: "Next paragraph",
                    enabled: state.canNextParagraph,
                    action: onNextParagraph
                )
                TransportButton(
                    systemImage: "forward.end.fill",
                    label: "Next chapter",
                    enabled: state.canNextChapter,
                    action: onNextChapter
                )
            }
            if !state.canPlayPause {
                Text("Text-only bundle — no audio to play.")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity)
        .background(Theme.surface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transport-bar")
    }
}

/// One transport button — symbol + accessible name, enabled state from
/// the snapshot's bounds facts.
private struct TransportButton: View {
    let systemImage: String
    let label: String
    let enabled: Bool
    let action: () -> Void
    var identifier: String?

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .medium))
                .frame(width: 44, height: 44)
        }
        .disabled(!enabled)
        .accessibilityLabel(label)
        .foregroundStyle(enabled ? Theme.foreground : Theme.muted)
        .modifier(TransportIdentifier(identifier: identifier))
    }
}

/// Applies the identifier only when present (keeps call sites clean).
private struct TransportIdentifier: ViewModifier {
    let identifier: String?

    func body(content: Content) -> some View {
        if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}
