import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("Library") {
                    Label("No books yet", systemImage: "book")
                }
                Section("Voices") {
                    Label("Voice catalog", systemImage: "waveform")
                }
            }
            .navigationTitle("TaleTrek")
        }
    }
}

#Preview {
    ContentView()
}
