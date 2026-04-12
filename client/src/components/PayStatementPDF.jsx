import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica' },
  header: { marginBottom: 20, borderBottom: '1 solid #333', paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  logo: { width: 80, height: 80, objectFit: 'contain' },
  headerText: { flex: 1 },
  businessName: { fontSize: 18, fontWeight: 'bold', fontFamily: 'Helvetica-Bold' },
  docTitle: { fontSize: 14, marginTop: 4, color: '#555' },
  companyDetail: { fontSize: 8, color: '#555', marginTop: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  section: { marginBottom: 15 },
  sectionTitle: { fontSize: 11, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', marginBottom: 6, color: '#333', borderBottom: '0.5 solid #ccc', paddingBottom: 3 },
  label: { color: '#666', width: 160 },
  value: { flex: 1, textAlign: 'right' },
  bold: { fontFamily: 'Helvetica-Bold' },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f3f4f6', padding: 6, marginBottom: 2 },
  tableRow: { flexDirection: 'row', padding: 6, borderBottom: '0.5 solid #eee' },
  col1: { flex: 2 },
  col2: { flex: 1.5, textAlign: 'right' },
  col3: { flex: 1.5, textAlign: 'right' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 8, backgroundColor: '#1e40af', color: 'white', marginTop: 4 },
  summaryBox: { backgroundColor: '#f0fdf4', padding: 10, marginTop: 10, borderRadius: 4, border: '0.5 solid #bbf7d0' },
  balanceBox: { backgroundColor: '#fef3c7', padding: 10, marginTop: 10, borderRadius: 4, border: '0.5 solid #fde68a' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, textAlign: 'center', color: '#999', fontSize: 8, borderTop: '0.5 solid #ddd', paddingTop: 8 },
});

function formatMoney(amount, symbol = 'K') {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function PayStatementPDF({ consultant, payment, sales = [], summary = {}, settings = {} }) {
  const currency = settings.currencySymbol || settings.currency || 'K';
  const businessName = settings.businessName || 'Privtech Solutions Limited';

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          {settings.companyLogo && <Image style={styles.logo} src={settings.companyLogo} />}
          <View style={styles.headerText}>
            <Text style={styles.businessName}>{businessName}</Text>
            {settings.companyAddress && <Text style={styles.companyDetail}>{settings.companyAddress}</Text>}
            {settings.companyTpin && <Text style={styles.companyDetail}>TPIN: {settings.companyTpin}</Text>}
            {settings.companyPhone && <Text style={styles.companyDetail}>Tel: {settings.companyPhone}</Text>}
            {settings.companyEmail && <Text style={styles.companyDetail}>Email: {settings.companyEmail}</Text>}
            <Text style={styles.docTitle}>CONSULTANT PAY STATEMENT</Text>
          </View>
        </View>

        {/* Consultant & Payment Info */}
        <View style={styles.section}>
          <View style={styles.row}>
            <Text><Text style={styles.bold}>Consultant:</Text> {consultant.name}</Text>
            <Text><Text style={styles.bold}>Date:</Text> {formatDate(payment.createdAt || new Date())}</Text>
          </View>
          {consultant.phone && (
            <View style={styles.row}>
              <Text><Text style={styles.bold}>Phone:</Text> {consultant.phone}</Text>
            </View>
          )}
          <View style={styles.row}>
            <Text><Text style={styles.bold}>Payment Type:</Text> {payment.type === 'commission' ? 'Commission Payment' : 'Communication Allowance'}</Text>
            {payment.paymentMethod && <Text><Text style={styles.bold}>Method:</Text> {payment.paymentMethod}</Text>}
          </View>
          {payment.reference && (
            <View style={styles.row}>
              <Text><Text style={styles.bold}>Reference:</Text> {payment.reference}</Text>
            </View>
          )}
          {(payment.periodFrom || payment.periodTo) && (
            <View style={styles.row}>
              <Text><Text style={styles.bold}>Period:</Text> {formatDate(payment.periodFrom)} — {formatDate(payment.periodTo)}</Text>
            </View>
          )}
        </View>

        {/* Payment Amount */}
        <View style={styles.totalRow}>
          <Text style={styles.bold}>AMOUNT PAID</Text>
          <Text style={styles.bold}>{formatMoney(payment.amount, currency)}</Text>
        </View>

        {/* Commission Structure */}
        <View style={[styles.section, { marginTop: 15 }]}>
          <Text style={styles.sectionTitle}>Commission Structure</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Base Rate (first {consultant.tierThreshold || 50} sales/month)</Text>
            <Text style={styles.value}>{formatMoney(consultant.commissionRate, currency)} per sale</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Tier Rate (after {consultant.tierThreshold || 50} sales)</Text>
            <Text style={styles.value}>{formatMoney(consultant.tierRate || 30, currency)} per sale</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Monthly Communication Allowance</Text>
            <Text style={styles.value}>{formatMoney(consultant.monthlyAllowance, currency)}</Text>
          </View>
        </View>

        {/* Sales in Period */}
        {sales.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Sales Attributed ({sales.length} sales)</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.col1, styles.bold]}>Order / Date</Text>
              <Text style={[styles.col2, styles.bold]}>Customer</Text>
              <Text style={[styles.col3, styles.bold]}>Amount</Text>
            </View>
            {sales.slice(0, 30).map((s, idx) => (
              <View key={idx} style={styles.tableRow}>
                <View style={styles.col1}>
                  <Text>{s.orderNumber}</Text>
                  <Text style={{ fontSize: 8, color: '#666' }}>{formatDate(s.date)}</Text>
                </View>
                <Text style={styles.col2}>{s.customerName || '-'}</Text>
                <Text style={styles.col3}>{formatMoney(s.totalPrice, currency)}</Text>
              </View>
            ))}
            {sales.length > 30 && (
              <View style={styles.tableRow}>
                <Text style={{ color: '#666', fontStyle: 'italic' }}>... and {sales.length - 30} more sales</Text>
              </View>
            )}
          </View>
        )}

        {/* Running Summary */}
        <View style={styles.summaryBox}>
          <Text style={[styles.bold, { marginBottom: 6, color: '#065f46' }]}>Commission Summary</Text>
          <View style={styles.row}>
            <Text>Total Sales Made</Text>
            <Text style={styles.bold}>{summary.totalSales || 0}</Text>
          </View>
          <View style={styles.row}>
            <Text>Total Commission Earned</Text>
            <Text style={styles.bold}>{formatMoney(summary.commissionEarned || 0, currency)}</Text>
          </View>
          <View style={styles.row}>
            <Text>Total Commission Paid (including this)</Text>
            <Text style={styles.bold}>{formatMoney(summary.commissionPaid || 0, currency)}</Text>
          </View>
          <View style={styles.row}>
            <Text>Total Allowance Paid</Text>
            <Text style={styles.bold}>{formatMoney(summary.allowancePaid || 0, currency)}</Text>
          </View>
        </View>

        {(summary.balance || 0) > 0 && (
          <View style={styles.balanceBox}>
            <View style={styles.row}>
              <Text style={[styles.bold, { color: '#92400e' }]}>Outstanding Balance</Text>
              <Text style={[styles.bold, { color: '#92400e' }]}>{formatMoney(summary.balance, currency)}</Text>
            </View>
          </View>
        )}

        {payment.notes && (
          <View style={[styles.section, { marginTop: 10 }]}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={{ color: '#555' }}>{payment.notes}</Text>
          </View>
        )}

        <View style={styles.footer}>
          <Text>This is a system-generated pay statement from {businessName}.</Text>
          <Text style={{ marginTop: 2 }}>Generated on {formatDate(new Date())}</Text>
        </View>
      </Page>
    </Document>
  );
}
