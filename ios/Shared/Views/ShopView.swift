import SwiftUI
import SwiftData

/// Hauptansicht im Laden: oben Scanner, darunter Warenkorb, unten Summe + Bezahlen.
struct ShopView: View {
    @State private var model: ShopModel
    @State private var showManualEntry = false
    @State private var checkout: CheckoutResponse?
    @State private var paidOrder: Order?
    @State private var isStartingCheckout = false
    @Environment(\.modelContext) private var modelContext

    init(slug: String) {
        _model = State(initialValue: ShopModel(slug: slug))
    }

    var body: some View {
        VStack(spacing: 0) {
            if model.isLoading && model.store == nil {
                ProgressView("Laden wird geöffnet …").frame(maxHeight: .infinity)
            } else if let error = model.loadError, model.store == nil {
                ContentUnavailableView {
                    Label("Keine Verbindung", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Erneut versuchen") { Task { await model.start() } }
                        .buttonStyle(.borderedProminent)
                }
            } else if let store = model.store, !store.acceptingPayments {
                ContentUnavailableView(
                    "Gerade nicht verfügbar",
                    systemImage: "pause.circle",
                    description: Text("\(store.name) nimmt im Moment keine Zahlungen per Pay Inside an. Bitte nutze die Kasse.")
                )
            } else {
                shopping
            }
        }
        .navigationTitle(model.store?.name ?? "Laden")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showManualEntry = true
                } label: {
                    Image(systemName: "keyboard")
                }
                .accessibilityLabel("Barcode eintippen")
            }
        }
        .overlay(alignment: .top) {
            if let toast = model.toast {
                ToastView(toast: toast).id(toast.id)
            }
        }
        .animation(.spring(duration: 0.3), value: model.toast)
        .task { await model.start() }
        .sheet(isPresented: $showManualEntry) {
            ManualEntryView { code in
                Task { await model.handleScan(code) }
            }
            .presentationDetents([.height(230)])
        }
        .sheet(item: $checkout) { co in
            CheckoutView(model: model, checkout: co) { order in
                checkout = nil
                StoredReceipt.upsert(order, in: modelContext)
                // kurz warten, bis das Bezahl-Sheet geschlossen ist
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    paidOrder = order
                }
            }
        }
        .fullScreenCover(item: $paidOrder) { order in
            ExitPassView(order: order, api: model.api)
        }
    }

    private var shopping: some View {
        VStack(spacing: 0) {
            ScannerArea(symbologies: [.ean13, .ean8, .upce, .code128], isActive: checkout == nil && paidOrder == nil) { code in
                Task { await model.handleScan(code) }
            }
            .frame(height: 240)
            .clipped()

            if model.cart.isEmpty {
                ContentUnavailableView(
                    "Warenkorb ist leer",
                    systemImage: "barcode.viewfinder",
                    description: Text("Halte die Kamera auf den Barcode deines ersten Produkts.")
                )
            } else {
                List {
                    ForEach(model.cart) { line in
                        CartRow(line: line, onPlus: { model.increment(line) }, onMinus: { model.decrement(line) })
                    }
                    .onDelete { model.remove(atOffsets: $0) }
                }
                .listStyle(.plain)
            }

            payBar
        }
    }

    private var payBar: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(model.itemCount) Artikel").font(.footnote).foregroundStyle(.secondary)
                Text(Money.format(model.totalCents)).font(.title2.bold()).monospacedDigit()
            }
            Spacer()
            Button {
                Task {
                    isStartingCheckout = true
                    checkout = await model.checkout()
                    isStartingCheckout = false
                }
            } label: {
                if isStartingCheckout {
                    ProgressView().frame(minWidth: 110)
                } else {
                    Text("Bezahlen").frame(minWidth: 110)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.cart.isEmpty || isStartingCheckout)
        }
        .padding()
        .background(.bar)
    }
}

struct CartRow: View {
    let line: CartLine
    let onPlus: () -> Void
    let onMinus: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(line.name).lineLimit(2)
                    if line.minAge > 0 {
                        Text("\(line.minAge)+")
                            .font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.orange.opacity(0.2), in: Capsule())
                            .foregroundStyle(.orange)
                    }
                }
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 8) {
                Button(action: onMinus) { Image(systemName: "minus.circle") }
                Text("\(line.qty)").monospacedDigit().frame(minWidth: 20)
                if !line.weighed {
                    Button(action: onPlus) { Image(systemName: "plus.circle") }
                }
            }
            .buttonStyle(.borderless)
            .font(.title3)
            Text(Money.format(line.lineCents))
                .bold()
                .monospacedDigit()
                .frame(minWidth: 64, alignment: .trailing)
        }
        .padding(.vertical, 4)
    }

    private var subtitle: String {
        var s = Money.format(line.unitCents)
        if line.depositCents > 0 { s += " + \(Money.format(line.depositCents)) Pfand" }
        if line.weighed { s += " · Waage" }
        return s
    }
}

struct ManualEntryView: View {
    let onAdd: (String) -> Void
    @State private var code = ""
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Barcode-Nummer eintippen").font(.headline)
            TextField("z. B. 4006381333931", text: $code)
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)
                .font(.title3.monospacedDigit())
                .focused($focused)
            Button {
                onAdd(code)
                dismiss()
            } label: {
                Text("Hinzufügen").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(code.count < 6)
        }
        .padding()
        .onAppear { focused = true }
    }
}
