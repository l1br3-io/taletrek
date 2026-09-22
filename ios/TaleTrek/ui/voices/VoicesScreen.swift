import SwiftUI

/// The voice catalog — pre-download for offline, the optional override
/// (nil = kernel default), storage management. Never a prerequisite:
/// the convert lane resolves the default voice in-job.
struct VoicesScreen: View {
    @StateObject private var model: VoicesViewModel

    init(store: VoiceStore = .standard) {
        _model = StateObject(wrappedValue: VoicesViewModel(store: store))
    }

    var body: some View {
        List {
            Section {
                espeakRow
            } header: {
                Text("Speech data")
            } footer: {
                Text(
                    "The phonemizer data downloads with your first conversion — "
                        + "nothing to set up here."
                )
            }

            Section {
                defaultRow
                ForEach(model.rows) { row in
                    voiceRow(row)
                }
            } header: {
                Text("Voices")
            } footer: {
                Text("The selected voice is used for new conversions.")
            }

            if let failure = model.failure {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Download failed")
                            .font(.body.weight(.medium))
                        Text(failure.message)
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                        Button("Retry") {
                            model.download(failure.voice)
                        }
                        .font(.caption)
                    }
                }
            }
        }
        .navigationTitle("Voices")
    }

    private var espeakRow: some View {
        HStack {
            Label(
                model.espeakPresent ? "Phonemizer data present" : "Phonemizer data not downloaded yet",
                systemImage: model.espeakPresent ? "checkmark.circle" : "arrow.down.circle"
            )
            .foregroundStyle(model.espeakPresent ? Theme.foreground : Theme.muted)
            Spacer()
        }
    }

    private var defaultRow: some View {
        Button {
            model.select(nil)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Default")
                        .font(.body.weight(.medium))
                        .foregroundStyle(Theme.foreground)
                    Text("The kernel's built-in pick")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                }
                Spacer()
                if model.selected == nil {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel("Selected")
                }
            }
        }
        .accessibilityIdentifier("voice-default")
    }

    private func voiceRow(_ row: VoicesViewModel.Row) -> some View {
        HStack {
            Button {
                model.select(row.voice.id)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.voice.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Theme.foreground)
                    Text(
                        "\(row.voice.language) · \(row.voice.quality) · "
                            + String(format: "%.1f MB", Double(row.voice.sizeBytes) / 1_000_000)
                    )
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            stateControls(row)
        }
        .accessibilityIdentifier("voice-row-\(row.voice.id)")
    }

    @ViewBuilder
    private func stateControls(_ row: VoicesViewModel.Row) -> some View {
        if let download = model.downloads[row.voice.id] {
            VStack(alignment: .trailing) {
                ProgressView(value: download.total > 0 ? Double(download.done) : nil)
                    .frame(width: 90)
                Text(
                    download.total > 0
                        ? "\(Int(download.done)) / \(Int(download.total)) bytes"
                        : "\(Int(download.done)) bytes"
                )
                .font(.caption2)
                .foregroundStyle(Theme.muted)
            }
        } else if row.cached {
            HStack(spacing: 12) {
                if model.selected == row.voice.id {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel("Selected")
                }
                Button {
                    model.delete(row.voice.id)
                } label: {
                    Image(systemName: "trash")
                        .foregroundStyle(Theme.muted)
                }
                .accessibilityLabel("Delete \(row.voice.name)")
            }
        } else {
            Button {
                model.download(row.voice.id)
            } label: {
                Image(systemName: "arrow.down.circle")
            }
            .disabled(model.busy.contains(row.voice.id))
            .accessibilityLabel("Download \(row.voice.name)")
        }
    }
}
