import { useEffect, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { FiX } from 'react-icons/fi';

const SCANNER_ID = 'barcode-scanner-region';

export default function BarcodeScanner({ onScan, onClose }) {
  const [error, setError] = useState('');
  const scannerRef = useRef(null);
  const scannedRef = useRef(false);

  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      const state = scanner.getState();
      // 2 = SCANNING, 3 = PAUSED
      if (state === 2 || state === 3) {
        await scanner.stop();
      }
    } catch {
      // ignore
    }
    try {
      scanner.clear();
    } catch {
      // ignore
    }
    scannerRef.current = null;
  }, []);

  const handleClose = useCallback(async () => {
    await stopScanner();
    onClose();
  }, [stopScanner, onClose]);

  useEffect(() => {
    let cancelled = false;

    const startScanner = async () => {
      // Small delay to ensure DOM element is rendered
      await new Promise(r => setTimeout(r, 300));
      if (cancelled) return;

      const el = document.getElementById(SCANNER_ID);
      if (!el) {
        setError('Scanner container not found. Please try again.');
        return;
      }

      const scanner = new Html5Qrcode(SCANNER_ID);
      scannerRef.current = scanner;

      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 150 } },
          (decodedText) => {
            if (scannedRef.current) return;
            scannedRef.current = true;
            scanner.stop().then(() => {
              try { scanner.clear(); } catch {}
              scannerRef.current = null;
              onScan(decodedText);
            }).catch(() => {
              scannerRef.current = null;
              onScan(decodedText);
            });
          },
          () => {}
        );
      } catch (err) {
        console.error('Scanner error:', err);
        setError('Could not access camera. Please allow camera access and try again, or type the serial number manually.');
      }
    };

    startScanner();

    return () => {
      cancelled = true;
      stopScanner();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">Scan Barcode</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600">
            <FiX size={20} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {error ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
              {error}
            </div>
          ) : (
            <p className="text-sm text-gray-500">Point your camera at the barcode on the product</p>
          )}
          <div id={SCANNER_ID} className="w-full rounded-lg overflow-hidden" style={{ minHeight: 250 }} />
          <div className="flex justify-end">
            <button onClick={handleClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-1">
              <FiX size={14} /> Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
