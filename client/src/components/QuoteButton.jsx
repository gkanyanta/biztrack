import { useState } from 'react';
import { pdf } from '@react-pdf/renderer';
import { FiDownload } from 'react-icons/fi';
import QuotePDF from './QuotePDF';
import { getQuotePdfData } from '../services/api';

export default function QuoteButton({ quoteId, quote: quoteProp, settings: settingsProp, size = 16, className = '' }) {
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    try {
      let quote, settings;
      if (quoteProp && settingsProp) {
        quote = quoteProp;
        settings = settingsProp;
      } else {
        const { data } = await getQuotePdfData(quoteId);
        quote = data.quote;
        settings = data.settings;
      }
      const blob = await pdf(<QuotePDF quote={quote} settings={settings} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Quote-${quote.quoteNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to generate quote:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleDownload}
      disabled={loading}
      className={`inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 disabled:opacity-50 ${className}`}
      title="Download Quote"
    >
      <FiDownload size={size} className={loading ? 'animate-spin' : ''} />
      {loading && <span className="text-xs">...</span>}
    </button>
  );
}
