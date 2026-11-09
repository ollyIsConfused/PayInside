import Foundation
import SwiftData

/// Digitaler Bon, lokal auf dem Gerät gespeichert.
@Model
final class StoredReceipt {
    @Attribute(.unique) var orderId: String
    var storeName: String
    var totalCents: Int
    var paidAt: Date
    var payload: Data

    init(order: Order) {
        orderId = order.id
        storeName = order.store.name
        totalCents = order.totalCents
        paidAt = order.paidAt ?? order.createdAt
        payload = (try? JSONCoding.encoder.encode(order)) ?? Data()
    }

    var order: Order? {
        try? JSONCoding.decoder.decode(Order.self, from: payload)
    }

    func update(with order: Order) {
        if let data = try? JSONCoding.encoder.encode(order) { payload = data }
    }

    /// Speichert oder aktualisiert einen Bon.
    @MainActor
    static func upsert(_ order: Order, in context: ModelContext) {
        let id = order.id
        let existing = try? context.fetch(FetchDescriptor<StoredReceipt>(predicate: #Predicate { $0.orderId == id })).first
        if let existing {
            existing.update(with: order)
        } else {
            context.insert(StoredReceipt(order: order))
        }
        try? context.save()
    }
}
