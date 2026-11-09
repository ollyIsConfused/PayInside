import SwiftUI
import StripePaymentSheet

/// Zusammenfassung + Bezahlung (Apple Pay / Karte über Stripe, im Testmodus simuliert).
struct CheckoutView: View {
    let model: ShopModel
    let checkout: CheckoutResponse
    let onPaid: (Order) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var paymentSheet: PaymentSheet?
    @State private var isConfirming = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Dein Einkauf") {
                    ForEach(checkout.items, id: \.code) { item in
                        HStack {
                            Text("\(item.qty) × \(item.name)")
                            Spacer()
                            Text(Money.format(item.lineCents)).monospacedDigit()
                        }
                    }
                }
                Section {
                    HStack {
                        Text("Summe").bold()
                        Spacer()
                        Text(Money.format(checkout.totalCents)).bold().monospacedDigit()
                    }
                    if checkout.depositCents > 0 {
                        Text("inkl. \(Money.format(checkout.depositCents)) Pfand")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if checkout.payment.provider == "mock" {
                    Section {
                        Label("Testmodus – es wird kein echtes Geld bewegt.", systemImage: "testtube.2")
                            .foregroundStyle(.orange)
                    }
                }
                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red) }
                }
            }
            .safeAreaInset(edge: .bottom) {
                payButton
                    .padding()
                    .background(.bar)
            }
            .navigationTitle("Bezahlen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") {
                        Task { await model.cancel(orderId: checkout.orderId) }
                        dismiss()
                    }
                    .disabled(isConfirming)
                }
            }
        }
        .interactiveDismissDisabled(isConfirming)
        .onAppear(perform: preparePaymentSheet)
    }

    @ViewBuilder
    private var payButton: some View {
        if isConfirming {
            ProgressView("Zahlung wird bestätigt …").frame(maxWidth: .infinity, minHeight: 50)
        } else if checkout.payment.provider == "stripe", let paymentSheet {
            PaymentSheet.PaymentButton(paymentSheet: paymentSheet, onCompletion: handle) {
                payLabel
            }
        } else if checkout.payment.provider == "mock" {
            Button {
                Task {
                    isConfirming = true
                    if let order = await model.mockPay(orderId: checkout.orderId) {
                        onPaid(order)
                    } else {
                        isConfirming = false
                    }
                }
            } label: {
                payLabel
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, minHeight: 50)
        }
    }

    private var payLabel: some View {
        Text("\(Money.format(checkout.totalCents)) bezahlen")
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 12))
            .foregroundStyle(.white)
    }

    private func preparePaymentSheet() {
        guard checkout.payment.provider == "stripe",
              let secret = checkout.payment.clientSecret,
              let key = checkout.payment.publishableKey else { return }
        STPAPIClient.shared.publishableKey = key
        var config = PaymentSheet.Configuration()
        config.merchantDisplayName = model.store?.name ?? "Pay Inside"
        config.applePay = .init(merchantId: model.store?.payment.applePayMerchantId ?? AppConfig.applePayMerchantID,
                                merchantCountryCode: "DE")
        config.returnURL = "payinside://stripe-redirect"
        config.allowsDelayedPaymentMethods = false
        paymentSheet = PaymentSheet(paymentIntentClientSecret: secret, configuration: config)
    }

    private func handle(_ result: PaymentSheetResult) {
        switch result {
        case .completed:
            isConfirming = true
            Task {
                if let order = await model.awaitPaid(orderId: checkout.orderId) {
                    onPaid(order)
                } else {
                    isConfirming = false
                    errorText = "Zahlung wurde nicht bestätigt. Falls Geld abgebucht wurde, wende dich bitte an das Personal."
                }
            }
        case .canceled:
            break
        case .failed(let error):
            errorText = error.localizedDescription
        }
    }
}
