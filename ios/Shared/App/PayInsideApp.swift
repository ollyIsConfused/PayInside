import SwiftUI
import SwiftData
import StripePaymentSheet

@main
struct PayInsideApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(for: StoredReceipt.self)
    }
}

enum Route: Hashable {
    case store(String)
}

struct RootView: View {
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            HomeView(onStore: open)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .store(let slug):
                        ShopView(slug: slug)
                    }
                }
        }
        .tint(Color.accentColor)
        // payinside://s/<slug> sowie Rückkehr aus Stripe-Weiterleitungen (3-D Secure)
        .onOpenURL(perform: handle)
        // Universal Link / App Clip: https://<domain>/s/<slug>
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { handle(url) }
        }
    }

    private func handle(_ url: URL) {
        if StripeAPI.handleURLCallback(with: url) { return }
        if let slug = AppConfig.storeSlug(from: url) { open(slug) }
    }

    private func open(_ slug: String) {
        if case .store(let current)? = path.last, current == slug { return }
        path = [.store(slug)]
    }
}
