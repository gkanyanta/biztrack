import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica' },
  header: { marginBottom: 20, borderBottom: '1 solid #333', paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  logo: { width: 60, height: 60, objectFit: 'contain' },
  headerText: { flex: 1 },
  businessName: { fontSize: 18, fontWeight: 'bold', fontFamily: 'Helvetica-Bold' },
  receiptTitle: { fontSize: 14, marginTop: 4, color: '#555' },
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
  creditBox: { backgroundColor: '#fef3c7', padding: 10, marginTop: 10, borderRadius: 4 },
  creditLabel: { fontFamily: 'Helvetica-Bold', color: '#92400e' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, textAlign: 'center', color: '#999', fontSize: 8, borderTop: '0.5 solid #ddd', paddingTop: 8 },
  paymentBadge: { padding: '3 8', borderRadius: 3, fontSize: 9, alignSelf: 'flex-start' },
  paidBadge: { backgroundColor: '#d1fae5', color: '#065f46' },
  unpaidBadge: { backgroundColor: '#fee2e2', color: '#991b1b' },
  partialBadge: { backgroundColor: '#fef3c7', color: '#92400e' },
});

function formatMoney(amount, symbol = 'K') {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ReceiptPDF({ sale, settings = {} }) {
  const currency = settings.currencySymbol || settings.currency || 'K';
  const businessName = settings.businessName || 'BizTrack';
  const subtotal = parseFloat(sale.totalPrice) || 0;
  const shipping = parseFloat(sale.shippingCharge) || 0;
  const discount = parseFloat(sale.discount) || 0;
  const grandTotal = subtotal + shipping - discount;
  const amountPaid = parseFloat(sale.amountPaid) || 0;
  const balance = grandTotal - amountPaid;
  const isCredit = sale.paymentType === 'Credit';

  const badgeStyle = sale.paymentStatus === 'Paid' ? styles.paidBadge : sale.paymentStatus === 'Partial' ? styles.partialBadge : styles.unpaidBadge;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          {settings.companyLogo && <Image style={styles.logo} src={settings.companyLogo} />}
          <View style={styles.headerText}>
            <Text style={styles.businessName}>{businessName}</Text>
            <Text style={styles.receiptTitle}>RECEIPT / INVOICE</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text><Text style={styles.bold}>Receipt #:</Text> {sale.orderNumber}</Text>
            <Text><Text style={styles.bold}>Date:</Text> {formatDate(sale.date)}</Text>
          </View>
          <View style={styles.row}>
            <Text><Text style={styles.bold}>Payment:</Text> {sale.paymentType} - {sale.paymentMethod || 'N/A'}</Text>
            <View style={[styles.paymentBadge, badgeStyle]}>
              <Text>{sale.paymentStatus}</Text>
            </View>
          </View>
        </View>

        {(sale.customerName || sale.customer?.name) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Customer</Text>
            <View style={styles.row}>
              <Text style={styles.label}>Name</Text>
              <Text style={styles.value}>{sale.customerName || sale.customer?.name}</Text>
            </View>
            {(sale.customerPhone || sale.customer?.phone) && (
              <View style={styles.row}>
                <Text style={styles.label}>Phone</Text>
                <Text style={styles.value}>{sale.customerPhone || sale.customer?.phone}</Text>
              </View>
            )}
            {(sale.customerCity || sale.customer?.city) && (
              <View style={styles.row}>
                <Text style={styles.label}>City</Text>
                <Text style={styles.value}>{sale.customerCity || sale.customer?.city}</Text>
              </View>
            )}
            {sale.deliveryAddress && (
              <View style={styles.row}>
                <Text style={styles.label}>Delivery Address</Text>
                <Text style={styles.value}>{sale.deliveryAddress}</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Items</Text>
          <View style={styles.tableHeader}>
            <Text style={[styles.col1, styles.bold]}>Product</Text>
            <Text style={[styles.col2, styles.bold]}>Qty</Text>
            <Text style={[styles.col3, styles.bold]}>Unit Price</Text>
            <Text style={[styles.col4, styles.bold]}>Total</Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.col1}>{sale.product?.name || 'Product'}</Text>
            <Text style={styles.col2}>{sale.qty}</Text>
            <Text style={styles.col3}>{formatMoney(sale.unitPrice, currency)}</Text>
            <Text style={styles.col4}>{formatMoney(subtotal, currency)}</Text>
          </View>
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
            <Text style={styles.bold}>TOTAL</Text>
            <Text style={styles.bold}>{formatMoney(grandTotal, currency)}</Text>
          </View>
        </View>

        {isCredit && (
          <View style={styles.creditBox}>
            <Text style={styles.creditLabel}>Credit Sale Details</Text>
            <View style={[styles.row, { marginTop: 6 }]}>
              <Text>Amount Paid</Text>
              <Text>{formatMoney(amountPaid, currency)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={{ fontFamily: 'Helvetica-Bold' }}>Balance Due</Text>
              <Text style={{ fontFamily: 'Helvetica-Bold' }}>{formatMoney(balance, currency)}</Text>
            </View>
            {sale.creditDueDate && (
              <View style={styles.row}>
                <Text>Due Date</Text>
                <Text>{formatDate(sale.creditDueDate)}</Text>
              </View>
            )}
            {sale.creditNotes && (
              <View style={[styles.row, { marginTop: 4 }]}>
                <Text style={{ color: '#666' }}>{sale.creditNotes}</Text>
              </View>
            )}
          </View>
        )}

        {sale.notes && (
          <View style={[styles.section, { marginTop: 10 }]}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={{ color: '#555' }}>{sale.notes}</Text>
          </View>
        )}

        <View style={styles.footer}>
          <Text>{settings.receiptFooter || `Thank you for your business! - ${businessName}`}</Text>
        </View>
      </Page>
    </Document>
  );
}
