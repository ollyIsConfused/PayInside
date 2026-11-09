import SwiftUI
import SwiftData

/// Ausgangscode nach dem Bezahlen. Wird an der Schranke gescannt oder vom Personal geprüft.
struct ExitPassView: View {
    @State var order: Order
    let api: APIClient

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var showReceipt = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    if order.isExited {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 80))
                            .foregroundStyle(.green)
                        Text("Danke für deinen Einkauf!").font(.title.bold())
                        Text("Du bist ausgecheckt. Den Bon findest du unter „Meine Bons“.")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    } else if order.status == "refunded" {
                        Label("Dieser Einkauf wurde erstattet.", systemImage: "arrow.uturn.backward.circle")
                            .font(.headline)
                    } else if let token = order.exitToken, let image = QRCodeRenderer.image(for: token) {
                        Text("Bezahlt ✓").font(.title.bold()).foregroundStyle(.green)
                        Text("Halte diesen Code an den Scanner am Ausgang.")
                            .multilineTextAlignment(.center)
                        Image(uiImage: image)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .padding(16)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 20))
                            .frame(maxWidth: 340)
                            .accessibilityLabel("Ausgangscode")
                            .maxBrightness()
                    } else {
                        ProgressView("Ausgangscode wird geladen …")
                    }

                    if !order.isExited && order.needsAgeCheck {
                        notice("Altersbeschränkte Artikel: bitte Ausweis bereithalten.", icon: "person.text.rectangle")
                    }
                    if !order.isExited && order.needsAudit {
                        notice("Kurze Stichprobe: Bitte zeige deinen Einkauf dem Personal. Danke!", icon: "magnifyingglass")
                    }

                    Text("\(Money.format(order.totalCents)) · Bon-Nr. \(order.receiptNumber.map(String.init) ?? "–")")
                        .font(.headline)

                    Button("Bon anzeigen") { showReceipt = true }
                        .buttonStyle(.bordered)
                }
                .padding()
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(order.store.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .sheet(isPresented: $showReceipt) {
                NavigationStack { ReceiptView(order: order) }
            }
        }
        .task { await poll() }
    }

    private func notice(_ text: String, icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.subheadline.weight(.semibold))
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
            .foregroundStyle(.orange)
    }

    /// Prüft regelmäßig, ob der Kunde ausgecheckt ist, und erneuert den Code alle ~10 Minuten.
    private func poll() async {
        var ticks = 0
        while !Task.isCancelled && !order.isExited && order.status == "paid" {
            try? await Task.sleep(for: .seconds(4))
            ticks += 1
            guard let fresh = try? await api.order(id: order.id) else { continue }
            if fresh.exitStatus != order.exitStatus || fresh.status != order.status || ticks % 150 == 0 {
                order = fresh
                StoredReceipt.upsert(fresh, in: modelContext)
            }
        }
    }
}
