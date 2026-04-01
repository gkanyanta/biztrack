export function formatMoney(amount, symbol = 'K') {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

export function formatDateTime(date) {
  if (!date) return '';
  return new Date(date).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function calcMargin(costPrice, sellingPrice) {
  const cost = parseFloat(costPrice) || 0;
  const sell = parseFloat(sellingPrice) || 0;
  if (cost === 0) return 0;
  return ((sell - cost) / cost) * 100;
}

export function calcSuggestedPrice(costPrice, marginPercent) {
  const cost = parseFloat(costPrice) || 0;
  const margin = parseFloat(marginPercent) || 0;
  return cost * (1 + margin / 100);
}

export const STATUS_COLORS = {
  Pending: 'bg-yellow-100 text-yellow-800',
  Confirmed: 'bg-blue-100 text-blue-800',
  Shipped: 'bg-purple-100 text-purple-800',
  Delivered: 'bg-green-100 text-green-800',
  Cancelled: 'bg-red-100 text-red-800',
};

export const PAYMENT_COLORS = {
  Unpaid: 'bg-red-100 text-red-800',
  Partial: 'bg-yellow-100 text-yellow-800',
  Paid: 'bg-green-100 text-green-800',
};

export const EXPENSE_CATEGORIES = [
  'Facebook Ads',
  'WhatsApp Business',
  'Shipping',
  'Packaging',
  'Data/Internet',
  'Transport',
  'Storage',
  'Supplier Payments',
  'Other'
];

export const ORDER_STATUSES = ['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'];
export const PAYMENT_STATUSES = ['Unpaid', 'Partial', 'Paid'];
export const PAYMENT_METHODS = ['Mobile Money', 'Cash', 'Bank Transfer', 'Other'];
export const SOURCES = ['Facebook Ad', 'WhatsApp', 'Referral', 'Repeat Customer', 'Other'];
