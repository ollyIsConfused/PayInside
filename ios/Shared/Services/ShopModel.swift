import Foundation
import Observation

/// Zustand eines Einkaufs in einem Laden: Session, Katalog, Warenkorb, Checkout.
@MainActor
@Observable
final class ShopModel {
    let slug: String
    let api: APIClient

    private(set) var store: StoreInfo?
    private(set) var cart: [CartLine] = []
    private(set) var isLoading = true
    private(set) var loadError: String?
    var toast: Toast?

    private var catalog: [String: CatalogProduct] = [:]
    private var sessionExpiresAt: Date?

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    init(slug: String) {
        self.slug = slug
        self.api = APIClient()
        self.cart = CartStorage.load(slug: slug)
    }

    var totalCents: Int { cart.reduce(0) { $0 + $1.lineCents } }
    var itemCount: Int { cart.reduce(0) { $0 + $1.qty } }
    var depositCents: Int { cart.reduce(0) { $0 + $1.depositCents * $1.qty } }

    // MARK: Start

    func start() async {
        isLoading = true
        loadError = nil
        // Zwischengespeicherten Katalog sofort nutzen (schnell, funktioniert bei schlechtem Netz)
        if let cached = CatalogCache.load(slug: slug) {
            catalog = Dictionary(cached.catalog.products.map { ($0.code, $0) }, uniquingKeysWith: { a, _ in a })
        }
        do {
            try await ensureSession()
            await refreshCatalog()
            if let store { RecentStores.add(slug: store.slug, name: store.name) }
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }

    private func ensureSession(force: Bool = false) async throws {
        if !force, let exp = sessionExpiresAt, exp > Date().addingTimeInterval(600), store != nil { return }
        let res = try await api.startSession(slug: slug)
        sessionExpiresAt = res.expiresAt
        store = res.store
    }

    private func refreshCatalog() async {
        let cached = CatalogCache.load(slug: slug)
        let result: (CatalogResponse, String?)?
        do {
            result = try await api.catalog(slug: slug, etag: cached?.etag)
        } catch {
            return // offline – mit Cache weiterarbeiten
        }
        guard let changed = result else { return } // 304: unverändert
        let (fresh, etag) = changed
        catalog = Dictionary(fresh.products.map { ($0.code, $0) }, uniquingKeysWith: { a, _ in a })
        CatalogCache.save(slug: slug, catalog: fresh, etag: etag)
    }

    // MARK: Scannen

    func handleScan(_ raw: String) async {
        let code = Self.normalize(raw)
        guard !code.isEmpty else { return }
        // Eingangs-QR eines Ladens versehentlich gescannt?
        if code.hasPrefix("http") { return }

        var product: ResolvedProduct?
        if let p = catalog[code] {
            product = ResolvedProduct(code: p.code, name: p.name, unitCents: p.priceCents, depositCents: p.depositCents,
                                      vatRate: p.vatRate, minAge: p.minAge, weighed: false)
        } else {
            do {
                product = try await api.product(slug: slug, code: code)
            } catch let error as APIError where error.status == 404 {
                show("Artikel \(code) unbekannt – bitte an der Info melden", error: true)
                Haptics.error()
                return
            } catch {
                show(error.localizedDescription, error: true)
                Haptics.error()
                return
            }
        }
        guard let product else { return }

        if let i = cart.firstIndex(where: { $0.code == code }) {
            if product.weighed {
                show("Dieses Waagen-Etikett ist schon im Warenkorb", error: true)
                return
            }
            cart[i].qty = min(99, cart[i].qty + 1)
        } else {
            cart.insert(CartLine(code: code, name: product.name, unitCents: product.unitCents, depositCents: product.depositCents,
                                 minAge: product.minAge, weighed: product.weighed, qty: 1), at: 0)
        }
        persist()
        Haptics.success()
        show("✓ \(product.name)")
    }

    func increment(_ line: CartLine) {
        guard let i = cart.firstIndex(where: { $0.code == line.code }), !cart[i].weighed else { return }
        cart[i].qty = min(99, cart[i].qty + 1)
        persist()
    }

    func decrement(_ line: CartLine) {
        guard let i = cart.firstIndex(where: { $0.code == line.code }) else { return }
        cart[i].qty -= 1
        if cart[i].qty <= 0 { cart.remove(at: i) }
        persist()
    }

    func remove(atOffsets offsets: IndexSet) {
        cart.remove(atOffsets: offsets)
        persist()
    }

    func clearCart() {
        cart = []
        persist()
    }

    // MARK: Bezahlen

    func checkout() async -> CheckoutResponse? {
        do {
            try await ensureSession()
            return try await api.checkout(lines: cart)
        } catch let error as APIError {
            switch error.code {
            case "session_expired", "unauthorized":
                try? await ensureSession(force: true)
                show("Sitzung erneuert – bitte noch einmal tippen", error: true)
            case "unknown_products":
                if case .server(_, _, _, let unknown) = error {
                    cart.removeAll { unknown.contains($0.code) }
                    persist()
                }
                show("Einige Artikel sind nicht mehr verfügbar und wurden entfernt", error: true)
            default:
                show(error.localizedDescription, error: true)
            }
        } catch {
            show(error.localizedDescription, error: true)
        }
        return nil
    }

    func cancel(orderId: String) async {
        try? await api.cancel(orderId: orderId)
    }

    /// Wartet, bis der Server die Zahlung bestätigt hat (Webhook vom Zahlungsanbieter).
    func awaitPaid(orderId: String) async -> Order? {
        for _ in 0..<45 {
            let order = try? await api.order(id: orderId)
            if let order {
                if order.status == "paid" {
                    clearCart()
                    return order
                }
                if order.status == "canceled" { return nil }
            }
            try? await Task.sleep(for: .milliseconds(1500))
        }
        return nil
    }

    func mockPay(orderId: String) async -> Order? {
        do {
            let order = try await api.mockPay(orderId: orderId)
            clearCart()
            return order
        } catch {
            show(error.localizedDescription, error: true)
            return nil
        }
    }

    // MARK: Hilfen

    func show(_ text: String, error: Bool = false) {
        toast = Toast(text: text, isError: error)
        let id = toast?.id
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            if toast?.id == id { toast = nil }
        }
    }

    private func persist() {
        CartStorage.save(cart, slug: slug)
    }

    /// Wie auf dem Server: UPC-A → EAN-13, GTIN-14 → EAN-13, Leerzeichen entfernen.
    static func normalize(_ raw: String) -> String {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
        let digitsOnly = !s.isEmpty && s.allSatisfy(\.isNumber)
        if digitsOnly && s.count == 12 { return "0" + s }
        if digitsOnly && s.count == 14 && s.hasPrefix("0") { return String(s.dropFirst()) }
        return s
    }
}

// MARK: - Lokale Speicher

enum CartStorage {
    static func load(slug: String) -> [CartLine] {
        guard let data = UserDefaults.standard.data(forKey: "cart_\(slug)") else { return [] }
        return (try? JSONDecoder().decode([CartLine].self, from: data)) ?? []
    }

    static func save(_ cart: [CartLine], slug: String) {
        UserDefaults.standard.set(try? JSONEncoder().encode(cart), forKey: "cart_\(slug)")
    }
}

enum CatalogCache {
    struct Entry: Codable {
        let etag: String?
        let catalog: CatalogResponse
    }

    private static func url(_ slug: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("catalog-\(slug).json")
    }

    static func load(slug: String) -> Entry? {
        guard let data = try? Data(contentsOf: url(slug)) else { return nil }
        return try? JSONDecoder().decode(Entry.self, from: data)
    }

    static func save(slug: String, catalog: CatalogResponse, etag: String?) {
        if let data = try? JSONEncoder().encode(Entry(etag: etag, catalog: catalog)) {
            try? data.write(to: url(slug), options: .atomic)
        }
    }
}

struct RecentStore: Codable, Identifiable, Hashable {
    var id: String { slug }
    let slug: String
    let name: String
}

enum RecentStores {
    static func all() -> [RecentStore] {
        guard let data = UserDefaults.standard.data(forKey: "recentStores") else { return [] }
        return (try? JSONDecoder().decode([RecentStore].self, from: data)) ?? []
    }

    static func add(slug: String, name: String) {
        var list = all().filter { $0.slug != slug }
        list.insert(RecentStore(slug: slug, name: name), at: 0)
        UserDefaults.standard.set(try? JSONEncoder().encode(Array(list.prefix(10))), forKey: "recentStores")
    }
}
