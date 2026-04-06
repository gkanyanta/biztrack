import { useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { FiDownload } from 'react-icons/fi';
import ReceiptPDF from './ReceiptPDF';
import { getSaleReceipt } from '../services/api';

export default function ReceiptButton({ saleId, sale: saleProp, settings: settingsProp, size = 16, className = '' }) {
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    try {
      let sale, settings;
      if (saleProp && settingsProp) {
        sale = saleProp;
        settings = settingsProp;
      } else {
        const { data } = await getSaleReceipt(saleId);
        sale = data.sale;
        settings = data.settings;
      }
      const blob = await pdf(<ReceiptPDF sale={sale} settings={settings} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Receipt-${sale.orderNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to generate receipt:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleDownload}
      disabled={loading}
      className={`inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 disabled:opacity-50 ${className}`}
      title="Download Receipt"
    >
      <FiDownload size={size} className={loading ? 'animate-spin' : ''} />
      {loading && <span className="text-xs">...</span>}
    </button>
  );
}
