import SwiftUI

struct HomeView: View {
    let onStore: (String) -> Void
    @State private var scanning = false
    @State private var recent: [RecentStore] = []

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 14) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 52))
                        .foregroundStyle(.tint)
                    Text("Einkaufen ohne Kasse")
                        .font(.title.bold())
                    Text("Scanne den QR-Code am Eingang. Dann Produkte scannen, im Handy bezahlen und einfach rausgehen.")
                        .foregroundStyle(.secondary)
                    Button {
                        scanning = true
                    } label: {
                        Label("QR-Code am Eingang scannen", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                .padding(.vertical, 8)
            }

            if !recent.isEmpty {
                Section("Zuletzt besucht") {
                    ForEach(recent) { store in
                        Button {
                            onStore(store.slug)
                        } label: {
                            Label(store.name, systemImage: "storefront")
                        }
                    }
                }
            }

            Section {
                NavigationLink {
                    ReceiptsListView()
                } label: {
                    Label("Meine Bons", systemImage: "doc.text")
                }
                NavigationLink {
                    SettingsView()
                } label: {
                    Label("Einstellungen & Hilfe", systemImage: "gearshape")
                }
            }
        }
        .navigationTitle("Pay Inside")
        .onAppear { recent = RecentStores.all() }
        .sheet(isPresented: $scanning) {
            EntryScannerView { slug in
                scanning = false
                onStore(slug)
            }
        }
    }
}

/// Scannt den Eingangs-QR-Code eines Ladens.
struct EntryScannerView: View {
    let onStore: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var manual = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScannerArea(symbologies: [.qr]) { value in
                    if let url = URL(string: value), let slug = AppConfig.storeSlug(from: url) {
                        Haptics.success()
                        onStore(slug)
                    } else {
                        error = "Das ist kein Pay-Inside-Code."
                    }
                }
                .frame(maxHeight: .infinity)

                VStack(alignment: .leading, spacing: 8) {
                    if let error {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                    HStack {
                        TextField("Link oder Laden-Kürzel", text: $manual)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                            .submitLabel(.go)
                            .onSubmit(openManual)
                        Button("Öffnen", action: openManual)
                            .buttonStyle(.bordered)
                    }
                }
                .padding()
            }
            .navigationTitle("Eingang scannen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
        }
    }

    private func openManual() {
        let text = manual.trimmingCharacters(in: .whitespaces)
        if let url = URL(string: text), let slug = AppConfig.storeSlug(from: url) {
            onStore(slug)
        } else if text.range(of: "^[a-z0-9-]{1,64}$", options: .regularExpression) != nil {
            onStore(text)
        } else {
            error = "Bitte den Link vom Plakat oder das Kürzel des Ladens eingeben."
        }
    }
}
