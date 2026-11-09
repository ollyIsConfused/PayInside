import Foundation

enum AppConfig {
    /// Basis-URL des Servers. In Einstellungen (Debug) überschreibbar, sonst aus Info.plist (PIAPIBaseURL).
    static var apiBaseURL: URL {
        if let override = UserDefaults.standard.string(forKey: "apiBaseURLOverride"),
           !override.isEmpty, let url = URL(string: override) {
            return url
        }
        let raw = Bundle.main.object(forInfoDictionaryKey: "PIAPIBaseURL") as? String ?? ""
        return URL(string: raw) ?? URL(string: "http://localhost:3000")!
    }

    static var applePayMerchantID: String {
        Bundle.main.object(forInfoDictionaryKey: "PIApplePayMerchantID") as? String ?? "merchant.de.payinside"
    }

    static var isAppClip: Bool {
        #if APPCLIP
        return true
        #else
        return false
        #endif
    }

    static var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }

    /// Liest den Laden aus Links wie https://payinside.de/s/hofladen-sonnenberg oder payinside://s/hofladen-sonnenberg
    static func storeSlug(from url: URL) -> String? {
        let parts = url.pathComponents.filter { $0 != "/" }
        if url.scheme == "payinside", url.host == "s" { return parts.first.flatMap(valid) }
        if let i = parts.firstIndex(of: "s"), i + 1 < parts.count { return valid(parts[i + 1]) }
        if let i = parts.firstIndex(of: "shop"), i + 1 < parts.count { return valid(parts[i + 1]) }
        return nil
    }

    private static func valid(_ slug: String) -> String? {
        let ok = slug.range(of: "^[a-z0-9-]{1,64}$", options: .regularExpression) != nil
        return ok ? slug : nil
    }
}
