import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import Modal from './Modal';
import { FiCamera, FiX } from 'react-icons/fi';

export default function BarcodeScanner({ onScan, onClose }) {
  const [error, setError] = useState('');
  const scannerRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const scannerId = 'barcode-scanner-' + Date.now();
    if (containerRef.current) {
      containerRef.current.id = scannerId;
    }

    const scanner = new Html5Qrcode(scannerId);
    scannerRef.current = scanner;

    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 150 }, aspectRatio: 1.5 },
      (decodedText) => {
        scanner.stop().catch(() => {});
        onScan(decodedText);
      },
      () => {}
    ).catch((err) => {
      setError('Could not access camera. Please allow camera access or enter the serial number manually.');
      console.error('Scanner error:', err);
    });

    return () => {
      scanner.stop().catch(() => {});
    };
  }, []);

  return (
    <Modal isOpen onClose={onClose} title="Scan Barcode">
      <div className="space-y-3">
        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            {error}
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500">Point your camera at the barcode on the product</p>
            <div ref={containerRef} className="w-full rounded-lg overflow-hidden" />
          </>
        )}
        <div className="flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-1">
            <FiX size={14} /> Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
