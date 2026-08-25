import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica' },
  header: { marginBottom: 20, borderBottom: '1 solid #333', paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  logo: { width: 80, height: 80, objectFit: 'contain' },
  headerText: { flex: 1 },
  businessName: { fontSize: 18, fontWeight: 'bold', fontFamily: 'Helvetica-Bold' },
  quoteTitle: { fontSize: 14, marginTop: 4, color: '#555' },
  companyDetail: { fontSize: 8, color: '#555', marginTop: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  section: { marginBottom: 15 },
  sectionTitle: { fontSize: 11, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', marginBottom: 6, color: '#333', borderBottom: '0.5 solid #ccc', paddingBottom: 3 },
  label: { color: '#666', width: 120 },
  value: { flex: 1, textAlign: 'right' },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f3f4f6', padding: 6, marginBottom: 2 },
  tableRow: { flexDirection: 'row', padding: 6, borderBottom: '0.5 solid #eee' },
  col1: { flex: 3 },
  col2: { flex: 1, textAlign: 'center' },
  col3: { flex: 1.5, textAlign: 'right' },
  col4: { flex: 1.5, textAlign: 'right' },
  bold: { fontFamily: 'Helvetica-Bold' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 6 },
  grandTotal: { flexDirection: 'row', justifyContent: 'space-between', padding: 8, backgroundColor: '#1e40af', color: 'white', marginTop: 4 },
  validityBox: { backgroundColor: '#fef3c7', padding: 10, marginTop: 10, borderRadius: 4 },
  validityLabel: { fontFamily: 'Helvetica-Bold', color: '#92400e' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, textAlign: 'center', color: '#999', fontSize: 8, borderTop: '0.5 solid #ddd', paddingTop: 8 },
  statusBadge: { padding: '3 8', borderRadius: 3, fontSize: 9, alignSelf: 'flex-start' },
});

const STATUS_COLORS = {
  Sent: { backgroundColor: '#dbeafe', color: '#1e40af' },
  Accepted: { backgroundColor: '#d1fae5', color: '#065f46' },
  Declined: { backgroundColor: '#fee2e2', color: '#991b1b' },
  Expired: { backgroundColor: '#f3f4f6', color: '#6b7280' },
  Converted: { backgroundColor: '#ede9fe', color: '#5b21b6' },
};

function formatMoney(amount, symbol = 'K') {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function QuotePDF({ quote, settings = {} }) {
  const currency = settings.currencySymbol || settings.currency || 'K';
  const businessName = settings.businessName || 'BizTrack';
  const items = quote.items || [];
  const itemsTotal = items.reduce((sum, i) => sum + (parseFloat(i.totalPrice) || 0), 0);
  const shipping = parseFloat(quote.shippingCharge) || 0;
  const discount = parseFloat(quote.discount) || 0;
  const grandTotal = itemsTotal + shipping - discount;
  const isExpired = quote.expiresAt && new Date(quote.expiresAt) < new Date() && quote.status === 'Sent';
  const badgeStyle = STATUS_COLORS[isExpired ? 'Expired' : quote.status] || STATUS_COLORS.Sent;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          {settings.companyLogo && <Image style={styles.logo} src={settings.companyLogo} />}
          <View style={styles.headerText}>
            <Text style={styles.businessName}>{businessName}</Text>
            {settings.companyAddress && <Text style={styles.companyDetail}>{settings.companyAddress}</Text>}
            {settings.companyTpin && <Text style={styles.companyDetail}>TPIN: {settings.companyTpin}</Text>}
            {settings.companyPhone && <Text style={styles.companyDetail}>Tel: {settings.companyPhone}</Text>}
            {settings.companyEmail && <Text style={styles.companyDetail}>Email: {settings.companyEmail}</Text>}
            {settings.companyWebsite && <Text style={styles.companyDetail}>Web: {settings.companyWebsite}</Text>}
            <Text style={styles.quoteTitle}>PRICE QUOTATION</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text><Text style={styles.bold}>Quote #:</Text> {quote.quoteNumber}</Text>
            <Text><Text style={styles.bold}>Date:</Text> {formatDate(quote.date)}</Text>
          </View>
          <View style={styles.row}>
            {quote.consultant?.name && <Text><Text style={styles.bold}>Prepared by:</Text> {quote.consultant.name}</Text>}
            <View style={[styles.statusBadge, badgeStyle]}>
              <Text>{isExpired ? 'Expired' : quote.status}</Text>
            </View>
          </View>
        </View>

        {(quote.customerName || quote.customer?.name) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Prepared For</Text>
            <View style={styles.row}>
              <Text style={styles.label}>Name</Text>
              <Text style={styles.value}>{quote.customerName || quote.customer?.name}</Text>
            </View>
            {(quote.customerPhone || quote.customer?.phone) && (
              <View style={styles.row}>
                <Text style={styles.label}>Phone</Text>
                <Text style={styles.value}>{quote.customerPhone || quote.customer?.phone}</Text>
              </View>
            )}
            {(quote.customerCity || quote.customer?.city) && (
              <View style={styles.row}>
                <Text style={styles.label}>City</Text>
                <Text style={styles.value}>{quote.customerCity || quote.customer?.city}</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Items Quoted</Text>
          <View style={styles.tableHeader}>
            <Text style={[styles.col1, styles.bold]}>Product</Text>
            <Text style={[styles.col2, styles.bold]}>Qty</Text>
            <Text style={[styles.col3, styles.bold]}>Unit Price</Text>
            <Text style={[styles.col4, styles.bold]}>Total</Text>
          </View>
          {items.map((item, idx) => (
            <View key={idx} style={styles.tableRow}>
              <Text style={styles.col1}>{item.product?.name || 'Product'}</Text>
              <Text style={styles.col2}>{item.qty}</Text>
              <Text style={styles.col3}>{formatMoney(item.unitPrice, currency)}</Text>
              <Text style={styles.col4}>{formatMoney(item.totalPrice, currency)}</Text>
            </View>
          ))}
          {items.length > 1 && (
            <View style={[styles.totalRow, { borderTop: '0.5 solid #ccc', marginTop: 2 }]}>
              <Text style={styles.bold}>Subtotal</Text>
              <Text style={styles.bold}>{formatMoney(itemsTotal, currency)}</Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          {shipping > 0 && (
            <View style={styles.totalRow}>
              <Text>Shipping</Text>
              <Text>{formatMoney(shipping, currency)}</Text>
            </View>
          )}
          {discount > 0 && (
            <View style={styles.totalRow}>
              <Text>Discount</Text>
              <Text>-{formatMoney(discount, currency)}</Text>
            </View>
          )}
          <View style={styles.grandTotal}>
            <Text style={styles.bold}>ESTIMATED TOTAL</Text>
            <Text style={styles.bold}>{formatMoney(grandTotal, currency)}</Text>
          </View>
        </View>

        {quote.expiresAt && (
          <View style={styles.validityBox}>
            <View style={styles.row}>
              <Text style={styles.validityLabel}>Quote Valid Until</Text>
              <Text style={styles.validityLabel}>{formatDate(quote.expiresAt)}</Text>
            </View>
          </View>
        )}

        {quote.notes && (
          <View style={[styles.section, { marginTop: 10 }]}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={{ color: '#555' }}>{quote.notes}</Text>
          </View>
        )}

        <View style={styles.footer}>
          <Text>This is a price quotation, not an invoice — prices are subject to change after the validity date.</Text>
          <Text style={{ marginTop: 2 }}>{settings.receiptFooter || `Thank you for considering ${businessName}!`}</Text>
        </View>
      </Page>
    </Document>
  );
}
