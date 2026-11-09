import SwiftUI
import SwiftData

/// Digitaler Kassenbon inkl. MwSt-Aufstellung und TSE-Daten.
struct ReceiptView: View {
    let order: Order

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(spacing: 4) {
                    Text(order.store.name).font(.title3.bold())
                    Text(order.store.address).font(.footnote).foregroundStyle(.secondary)
                    if !order.store.taxNumber.isEmpty {
                        Text("St.-Nr./USt-IdNr.: \(order.store.taxNumber)").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)

                Divider()
                ForEach(order.items, id: \.code) { item in
                    HStack(alignment: .top) {
                        Text("\(item.qty > 1 ? "\(item.qty) × " : "")\(item.name)\(item.weighed == true ? " (Waage)" : "")")
                        Spacer()
                        Text("\(Money.format(item.unitCents * item.qty)) \(Self.letter(item.vatRate))").monospacedDigit()
                    }
                    if item.depositCents > 0 {
                        HStack {
                            Text("   Pfand").foregroundStyle(.secondary)
                            Spacer()
                            Text(Money.format(item.depositCents * item.qty)).monospacedDigit().foregroundStyle(.secondary)
                        }
                        .font(.footnote)
                    }
                }
                Divider()
                HStack {
                    Text("Summe").bold()
                    Spacer()
                    Text(Money.format(order.totalCents)).bold().monospacedDigit()
                }
                .font(.title3)

                Grid(alignment: .trailing, horizontalSpacing: 12, verticalSpacing: 4) {
                    GridRow {
                        Text("MwSt").gridColumnAlignment(.leading)
                        Text("Netto")
                        Text("Steuer")
                        Text("Brutto")
                    }
                    .foregroundStyle(.secondary)
                    ForEach(order.vatBreakdown, id: \.rate) { v in
                        GridRow {
                            Text("\(Self.letter(v.rate)) \(v.rate) %").gridColumnAlignment(.leading)
                            Text(Money.format(v.netCents))
                            Text(Money.format(v.vatCents))
                            Text(Money.format(v.grossCents))
                        }
                    }
                }
                .font(.caption.monospacedDigit())

                Text("Bezahlt unbar · Bon-Nr. \(order.receiptNumber.map(String.init) ?? "–") · \(order.paidAt?.formatted(date: .numeric, time: .shortened) ?? "–")")
                    .font(.footnote)

                if order.status == "refunded" {
                    Label("Erstattet", systemImage: "arrow.uturn.backward").foregroundStyle(.red)
                }

                Divider()
                Text(tseText)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            .padding()
        }
        .navigationTitle("Bon")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: plainText) { Image(systemName: "square.and.arrow.up") }
            }
        }
    }

    static func letter(_ rate: Int) -> String {
        rate == 19 ? "A" : rate == 7 ? "B" : "C"
    }

    private var tseText: String {
        guard let f = order.fiscal, f.ok else {
            return order.fiscal?.error == "TSE nicht eingerichtet" ? "TSE nicht eingerichtet" : "TSE ausgefallen"
        }
        return """
        TSE\(f.simulated == true ? " (SIMULIERT)" : ""): \(f.tssSerial ?? "–")
        Kasse: \(f.clientSerial ?? "–") · Trans.-Nr. \(f.txNumber.map(String.init) ?? "–")
        Start: \(f.timeStart ?? "–")
        Ende: \(f.timeEnd ?? "–")
        Sig.-Zähler: \(f.signatureCounter.map(String.init) ?? "–")
        Signatur: \(f.signature ?? "–")
        """
    }

    private var plainText: String {
        var lines = [order.store.name, order.store.address, ""]
        for i in order.items {
            lines.append("\(i.qty) × \(i.name)  \(Money.format(i.unitCents * i.qty))")
            if i.depositCents > 0 { lines.append("   Pfand  \(Money.format(i.depositCents * i.qty))") }
        }
        lines.append("")
        lines.append("Summe: \(Money.format(order.totalCents))")
        for v in order.vatBreakdown {
            lines.append("MwSt \(v.rate) %: \(Money.format(v.vatCents)) (Netto \(Money.format(v.netCents)))")
        }
        lines.append("Bon-Nr. \(order.receiptNumber.map(String.init) ?? "–") · \(order.paidAt?.formatted() ?? "")")
        lines.append("")
        lines.append(tseText)
        return lines.joined(separator: "\n")
    }
}

struct ReceiptsListView: View {
    @Query(sort: \StoredReceipt.paidAt, order: .reverse) private var receipts: [StoredReceipt]
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        List {
            ForEach(receipts) { receipt in
                if let order = receipt.order {
                    NavigationLink {
                        ReceiptView(order: order)
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(receipt.storeName)
                                Text(receipt.paidAt.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(Money.format(receipt.totalCents)).bold().monospacedDigit()
                        }
                    }
                }
            }
            .onDelete { offsets in
                for i in offsets { modelContext.delete(receipts[i]) }
                try? modelContext.save()
            }
        }
        .overlay {
            if receipts.isEmpty {
                ContentUnavailableView("Noch keine Bons", systemImage: "doc.text", description: Text("Nach deinem ersten Einkauf findest du den Bon hier."))
            }
        }
        .navigationTitle("Meine Bons")
    }
}

struct SettingsView: View {
    @AppStorage("apiBaseURLOverride") private var apiOverride = ""

    var body: some View {
        Form {
            Section("So funktioniert's") {
                Label("QR-Code am Eingang scannen", systemImage: "1.circle")
                Label("Barcodes der Produkte scannen", systemImage: "2.circle")
                Label("Mit Apple Pay oder Karte bezahlen", systemImage: "3.circle")
                Label("Ausgangscode an der Schranke zeigen", systemImage: "4.circle")
            }
            Section("Rechtliches") {
                Link("Impressum", destination: AppConfig.apiBaseURL.appendingPathComponent("impressum"))
                Link("Datenschutz", destination: AppConfig.apiBaseURL.appendingPathComponent("datenschutz"))
            }
            #if DEBUG
            Section {
                TextField("z. B. http://192.168.178.20:3000", text: $apiOverride)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text("Aktuell: \(AppConfig.apiBaseURL.absoluteString)").font(.caption).foregroundStyle(.secondary)
            } header: {
                Text("Entwicklung: Server-Adresse")
            } footer: {
                Text("Nur in Debug-Builds sichtbar. Leer lassen für den Standard aus der Build-Konfiguration.")
            }
            #endif
            Section {
                LabeledContent("Version", value: AppConfig.appVersion)
            }
        }
        .navigationTitle("Einstellungen")
    }
}
