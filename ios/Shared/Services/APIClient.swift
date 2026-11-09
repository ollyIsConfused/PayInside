import Foundation

enum APIError: LocalizedError {
    case server(status: Int, code: String, message: String, unknown: [String])
    case invalidResponse
    case offline

    var errorDescription: String? {
        switch self {
        case .server(_, _, let message, _): return message
        case .invalidResponse: return "Unerwartete Antwort vom Server."
        case .offline: return "Keine Internetverbindung. Bitte WLAN des Ladens nutzen oder kurz warten."
        }
    }

    var code: String? {
        if case .server(_, let code, _, _) = self { return code }
        return nil
    }

    var status: Int? {
        if case .server(let status, _, _, _) = self { return status }
        return nil
    }
}

/// Schlanker Client für die Pay-Inside-API.
final class APIClient {
    let baseURL: URL
    var sessionToken: String?
    private let http: URLSession

    init(baseURL: URL = AppConfig.apiBaseURL, sessionToken: String? = nil) {
        self.baseURL = baseURL
        self.sessionToken = sessionToken
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        self.http = URLSession(configuration: config)
    }

    // MARK: Endpunkte

    func store(slug: String) async throws -> StoreInfo {
        try await get("/v1/stores/\(escape(slug))")
    }

    func startSession(slug: String) async throws -> SessionResponse {
        struct Body: Encodable { let store: String; let client: String }
        let res: SessionResponse = try await send("POST", "/v1/sessions", body: Body(store: slug, client: AppConfig.isAppClip ? "ios-clip" : "ios"))
        sessionToken = res.sessionToken
        return res
    }

    /// Gibt nil zurück, wenn sich der Katalog seit `etag` nicht geändert hat.
    func catalog(slug: String, etag: String?) async throws -> (CatalogResponse, String?)? {
        var req = request("GET", "/v1/stores/\(escape(slug))/catalog")
        if let etag { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let (data, response) = try await perform(req)
        if response.statusCode == 304 { return nil }
        try check(data, response)
        let catalog = try JSONCoding.decoder.decode(CatalogResponse.self, from: data)
        return (catalog, response.value(forHTTPHeaderField: "ETag"))
    }

    func product(slug: String, code: String) async throws -> ResolvedProduct {
        try await get("/v1/stores/\(escape(slug))/products/\(escape(code))")
    }

    func checkout(lines: [CartLine]) async throws -> CheckoutResponse {
        try await send("POST", "/v1/checkout", body: CheckoutRequest(items: lines.map { .init(code: $0.code, qty: $0.qty) }))
    }

    func order(id: String) async throws -> Order {
        try await get("/v1/orders/\(escape(id))")
    }

    func mockPay(orderId: String) async throws -> Order {
        try await send("POST", "/v1/orders/\(escape(orderId))/mock-pay", body: Optional<String>.none)
    }

    func cancel(orderId: String) async throws {
        let _: Order = try await send("POST", "/v1/orders/\(escape(orderId))/cancel", body: Optional<String>.none)
    }

    // MARK: Grundlagen

    private func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s
    }

    private func request(_ method: String, _ path: String) -> URLRequest {
        var req = URLRequest(url: URL(string: path, relativeTo: baseURL)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = sessionToken { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await perform(request("GET", path))
        try check(data, response)
        return try JSONCoding.decoder.decode(T.self, from: data)
    }

    private func send<B: Encodable, T: Decodable>(_ method: String, _ path: String, body: B?) async throws -> T {
        var req = request(method, path)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONCoding.encoder.encode(body)
        }
        let (data, response) = try await perform(req)
        try check(data, response)
        return try JSONCoding.decoder.decode(T.self, from: data)
    }

    private func perform(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await http.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
            return (data, http)
        } catch let error as URLError {
            if [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost, .cannotFindHost].contains(error.code) {
                throw APIError.offline
            }
            throw error
        }
    }

    private func check(_ data: Data, _ response: HTTPURLResponse) throws {
        guard (200..<300).contains(response.statusCode) else {
            if let body = try? JSONCoding.decoder.decode(APIErrorBody.self, from: data) {
                throw APIError.server(status: response.statusCode, code: body.error, message: body.message, unknown: body.details?.unknown ?? [])
            }
            throw APIError.server(status: response.statusCode, code: "http_\(response.statusCode)", message: "Serverfehler (\(response.statusCode))", unknown: [])
        }
    }
}
