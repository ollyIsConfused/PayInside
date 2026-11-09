import Foundation

// Datenmodelle der Pay-Inside-API. Der Server liefert snake_case – der Decoder wandelt automatisch um.

struct StoreInfo: Codable, Hashable {
    let id: String
    let slug: String
    let name: String
    let address: String
    let status: String
    let acceptingPayments: Bool
    let catalogVersion: Int
    let weightBarcodeFormat: String
    let payment: PaymentConfig
    let entryUrl: String
}

struct PaymentConfig: Codable, Hashable {
    let provider: String // "stripe" | "mock" | "disabled"
    let publishableKey: String?
    let applePayMerchantId: String?
    let country: String
    let currency: String
}

struct SessionResponse: Codable {
    let sessionToken: String
    let expiresAt: Date
    let store: StoreInfo
}

struct CatalogProduct: Codable, Hashable {
    let code: String
    let name: String
    let priceCents: Int
    let vatRate: Int
    let depositCents: Int
    let minAge: Int
}

struct CatalogResponse: Codable {
    let version: Int
    let weightBarcodeFormat: String
    let products: [CatalogProduct]
}

/// Antwort von /products/:code – bei Waagen-Etiketten mit dem auf dem Etikett codierten Preis.
struct ResolvedProduct: Codable, Hashable {
    let code: String
    let name: String
    let unitCents: Int
    let depositCents: Int
    let vatRate: Int
    let minAge: Int
    let weighed: Bool
}

struct CartLine: Codable, Identifiable, Hashable {
    var id: String { code }
    let code: String
    let name: String
    let unitCents: Int
    let depositCents: Int
    let minAge: Int
    let weighed: Bool
    var qty: Int

    var lineCents: Int { (unitCents + depositCents) * qty }
}

struct CheckoutRequest: Encodable {
    struct Item: Encodable {
        let code: String
        let qty: Int
    }
    let items: [Item]
}

struct OrderItem: Codable, Hashable {
    let code: String
    let name: String
    let qty: Int
    let unitCents: Int
    let depositCents: Int
    let vatRate: Int
    let minAge: Int
    let lineCents: Int
    let weighed: Bool?
}

struct VatLine: Codable, Hashable {
    let rate: Int
    let grossCents: Int
    let netCents: Int
    let vatCents: Int
}

struct PaymentInfo: Codable, Hashable {
    let provider: String
    let clientSecret: String?
    let publishableKey: String?
}

struct CheckoutResponse: Codable, Identifiable, Hashable {
    var id: String { orderId }
    let orderId: String
    let totalCents: Int
    let depositCents: Int
    let items: [OrderItem]
    let vatBreakdown: [VatLine]
    let payment: PaymentInfo
}

struct OrderStore: Codable, Hashable {
    let slug: String
    let name: String
    let address: String
    let taxNumber: String
}

struct FiscalInfo: Codable, Hashable {
    let provider: String
    let ok: Bool
    let simulated: Bool?
    let tssSerial: String?
    let clientSerial: String?
    let txNumber: Int?
    let timeStart: String?
    let timeEnd: String?
    let signatureCounter: Int?
    let signature: String?
    let error: String?
}

struct Order: Codable, Identifiable, Hashable {
    let id: String
    let status: String // pending_payment | paid | canceled | refunded
    let store: OrderStore
    let receiptNumber: Int?
    let items: [OrderItem]
    let totalCents: Int
    let depositCents: Int
    let vatBreakdown: [VatLine]
    let checks: [String]
    let exitStatus: String // none | issued | used
    let exitToken: String?
    let exitTokenTtlSeconds: Int
    let fiscal: FiscalInfo?
    let paidAt: Date?
    let createdAt: Date
    let refundedAt: Date?

    var needsAgeCheck: Bool { checks.contains("age") }
    var needsAudit: Bool { checks.contains("audit") }
    var isExited: Bool { exitStatus == "used" }
}

struct APIErrorBody: Codable {
    struct Details: Codable { let unknown: [String]? }
    let error: String
    let message: String
    let details: Details?
}

enum JSONCoding {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = withFraction.date(from: s) ?? plain.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Ungültiges Datum: \(s)"))
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(withFraction.string(from: date))
        }
        return e
    }()
}
