import SwiftUI
import VisionKit
import Vision

/// Kamera-Scanner über Apples DataScannerViewController (iPhone XS und neuer).
struct BarcodeScannerView: UIViewControllerRepresentable {
    let symbologies: [VNBarcodeSymbology]
    var isActive: Bool = true
    let onCode: (String) -> Void

    static var isSupported: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: symbologies)],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        vc.delegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
        if isActive, !vc.isScanning {
            try? vc.startScanning()
        } else if !isActive, vc.isScanning {
            vc.stopScanning()
        }
    }

    static func dismantleUIViewController(_ vc: DataScannerViewController, coordinator: Coordinator) {
        vc.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        private var last = ""
        private var lastAt = Date.distantPast

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems { handle(item) }
        }

        // Antippen eines erkannten Codes zählt ihn erneut (z. B. 2× dasselbe Produkt)
        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            lastAt = .distantPast
            handle(item)
        }

        private func handle(_ item: RecognizedItem) {
            guard case .barcode(let barcode) = item, let value = barcode.payloadStringValue else { return }
            let now = Date()
            if value == last, now.timeIntervalSince(lastAt) < 2 { return }
            last = value
            lastAt = now
            onCode(value)
        }
    }
}

/// Scanner mit Kamera-Erlaubnis und Fallback (Simulator / ältere Geräte).
struct ScannerArea: View {
    let symbologies: [VNBarcodeSymbology]
    var isActive: Bool = true
    let onCode: (String) -> Void
    @State private var permitted: Bool?

    var body: some View {
        ZStack {
            Color.black
            switch permitted {
            case .some(true) where BarcodeScannerView.isSupported:
                BarcodeScannerView(symbologies: symbologies, isActive: isActive, onCode: onCode)
            case .some(true):
                Label("Scanner auf diesem Gerät nicht verfügbar – bitte Nummer eintippen", systemImage: "keyboard")
                    .foregroundStyle(.white).padding().multilineTextAlignment(.center)
            case .some(false):
                VStack(spacing: 12) {
                    Text("Kamera-Zugriff fehlt").font(.headline)
                    Button("In Einstellungen erlauben") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .foregroundStyle(.white)
            case .none:
                ProgressView().tint(.white)
            }
        }
        .task { permitted = await CameraPermission.request() }
    }
}
