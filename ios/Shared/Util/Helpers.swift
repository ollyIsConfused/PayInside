import SwiftUI
import UIKit
import AVFoundation
import CoreImage.CIFilterBuiltins

enum Money {
    private static let formatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "EUR"
        f.locale = Locale(identifier: "de_DE")
        return f
    }()

    static func format(_ cents: Int) -> String {
        formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "\(cents) ct"
    }
}

enum Haptics {
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

enum QRCodeRenderer {
    private static let context = CIContext()

    /// Erzeugt ein scharfes QR-Bild (ohne Weichzeichnen beim Skalieren mit .interpolation(.none) anzeigen).
    static func image(for string: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "L"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)),
              let cg = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

enum CameraPermission {
    /// Fragt bei Bedarf nach der Kamera-Erlaubnis.
    static func request() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }
}

/// Bildschirm beim Vorzeigen des Ausgangscodes hell machen.
struct MaxBrightness: ViewModifier {
    @State private var previous: CGFloat?

    private var screen: UIScreen? {
        (UIApplication.shared.connectedScenes.first { $0 is UIWindowScene } as? UIWindowScene)?.screen
    }

    func body(content: Content) -> some View {
        content
            .onAppear {
                previous = screen?.brightness
                screen?.brightness = 1
            }
            .onDisappear {
                if let previous { screen?.brightness = previous }
            }
    }
}

extension View {
    func maxBrightness() -> some View { modifier(MaxBrightness()) }
}

struct ToastView: View {
    let toast: ShopModel.Toast

    var body: some View {
        Text(toast.text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(toast.isError ? Color.red : Color.black.opacity(0.85), in: Capsule())
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityAddTraits(.isStaticText)
    }
}
