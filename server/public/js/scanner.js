// Kamera-Scanner für Barcodes und QR-Codes.
// Nutzt die eingebaute BarcodeDetector-API (Chrome/Android, Safari ab iOS 17 teilweise), sonst ZXing als Fallback.
(function () {
  'use strict';

  const NATIVE_FORMATS = { products: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'], qr: ['qr_code'] };

  async function nativeSupported(formats) {
    if (!('BarcodeDetector' in window)) return false;
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      return formats.every((f) => supported.includes(f));
    } catch {
      return false;
    }
  }

  /**
   * Startet den Scanner.
   * @param {HTMLVideoElement} video
   * @param {{ mode: 'products' | 'qr', onCode: (code: string) => void }} opts
   * @returns {Promise<() => void>} Stop-Funktion
   */
  async function start(video, opts) {
    const formats = NATIVE_FORMATS[opts.mode] || NATIVE_FORMATS.products;
    let last = '';
    let lastAt = 0;
    const emit = (code) => {
      const now = Date.now();
      if (code === last && now - lastAt < 2000) return; // gleichen Code nicht doppelt zählen
      last = code;
      lastAt = now;
      if (navigator.vibrate) navigator.vibrate(40);
      opts.onCode(code);
    };

    if (await nativeSupported(formats)) {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      await video.play();
      const detector = new window.BarcodeDetector({ formats });
      let running = true;
      const loop = async () => {
        if (!running) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) emit(codes[0].rawValue);
        } catch {
          /* Frame noch nicht bereit */
        }
        setTimeout(loop, 120);
      };
      loop();
      return () => {
        running = false;
        stream.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      };
    }

    if (!window.ZXingBrowser) throw new Error('Scanner-Bibliothek nicht geladen');
    const reader =
      opts.mode === 'qr' ? new window.ZXingBrowser.BrowserQRCodeReader() : new window.ZXingBrowser.BrowserMultiFormatReader();
    const controls = await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      video,
      (result) => {
        if (result) emit(result.getText());
      },
    );
    return () => controls.stop();
  }

  window.PIScanner = { start };
})();
