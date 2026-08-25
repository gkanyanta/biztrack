import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 9, fontFamily: 'Helvetica' },
  header: { marginBottom: 16, borderBottom: '1 solid #333', paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  logo: { width: 70, height: 70, objectFit: 'contain' },
  headerText: { flex: 1 },
  businessName: { fontSize: 16, fontWeight: 'bold', fontFamily: 'Helvetica-Bold' },
  reportTitle: { fontSize: 13, marginTop: 4, color: '#555' },
  companyDetail: { fontSize: 8, color: '#555', marginTop: 1 },
  bold: { fontFamily: 'Helvetica-Bold' },
  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  summaryBox: { flex: 1, borderRadius: 4, padding: 8 },
  summaryLabel: { fontSize: 8, color: '#555' },
  summaryValue: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginTop: 2 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f3f4f6', padding: 5, marginBottom: 2 },
  tableRow: { flexDirection: 'row', padding: 5, borderBottom: '0.5 solid #eee' },
  colOrder: { flex: 1.1 },
  colCustomer: { flex: 1.4 },
  colItems: { flex: 1.6 },
  colTotal: { flex: 0.9, textAlign: 'right' },
  colStatus: { flex: 0.9, textAlign: 'center' },
  colNote: { flex: 1.6 },
  statusBadge: { padding: '2 6', borderRadius: 3, fontSize: 7.5, textAlign: 'center' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, textAlign: 'center', color: '#999', fontSize: 8, borderTop: '0.5 solid #ddd', paddingTop: 8 },
});

const STATUS_STYLE = {
  Paid: { backgroundColor: '#d1fae5', color: '#065f46' },
  Partial: { backgroundColor: '#fef3c7', color: '#92400e' },
  Unpaid: { backgroundColor: '#fee2e2', color: '#991b1b' },
};

function formatMoney(amount, symbol = 'K') {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function DailySalesReportPDF({ report, settings = {} }) {
  const currency = settings.currencySymbol || settings.currency || 'K';
  const businessName = settings.businessName || 'BizTrack';
  const { date, consultant, orders = [], summary = {} } = report;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          {settings.companyLogo && <Image style={styles.logo} src={settings.companyLogo} />}
          <View style={styles.headerText}>
            <Text style={styles.businessName}>{businessName}</Text>
            {settings.companyPhone && <Text style={styles.companyDetail}>Tel: {settings.companyPhone}</Text>}
            <Text style={styles.reportTitle}>DAILY SALES REPORT — {formatDate(date)}</Text>
            {consultant?.name && <Text style={styles.companyDetail}>Consultant: {consultant.name}</Text>}
          </View>
        </View>

        <View style={styles.summaryRow}>
          <View style={[styles.summaryBox, { backgroundColor: '#eff6ff' }]}>
            <Text style={styles.summaryLabel}>Total Orders</Text>
            <Text style={styles.summaryValue}>{summary.totalOrders || 0}</Text>
          </View>
          <View style={[styles.summaryBox, { backgroundColor: '#eff6ff' }]}>
            <Text style={styles.summaryLabel}>Total Revenue</Text>
            <Text style={styles.summaryValue}>{formatMoney(summary.totalRevenue, currency)}</Text>
          </View>
          <View style={[styles.summaryBox, { backgroundColor: '#d1fae5' }]}>
            <Text style={styles.summaryLabel}>Paid ({summary.paidCount || 0})</Text>
            <Text style={[styles.summaryValue, { color: '#065f46' }]}>{formatMoney(summary.paidAmount, currency)}</Text>
          </View>
          <View style={[styles.summaryBox, { backgroundColor: '#fee2e2' }]}>
            <Text style={styles.summaryLabel}>Outstanding ({(summary.partialCount || 0) + (summary.unpaidCount || 0)})</Text>
            <Text style={[styles.summaryValue, { color: '#991b1b' }]}>{formatMoney(summary.totalOutstanding, currency)}</Text>
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={[styles.colOrder, styles.bold]}>Order</Text>
          <Text style={[styles.colCustomer, styles.bold]}>Customer</Text>
          <Text style={[styles.colItems, styles.bold]}>Items</Text>
          <Text style={[styles.colTotal, styles.bold]}>Total</Text>
          <Text style={[styles.colStatus, styles.bold]}>Payment</Text>
          <Text style={[styles.colNote, styles.bold]}>Note</Text>
        </View>
        {orders.map((o, idx) => (
          <View key={idx} style={styles.tableRow}>
            <Text style={styles.colOrder}>{o.orderNumber}</Text>
            <Text style={styles.colCustomer}>{o.customerName}</Text>
            <Text style={styles.colItems}>{o.items.map(i => `${i.name} x${i.qty}`).join(', ')}</Text>
            <Text style={styles.colTotal}>{formatMoney(o.totalPrice, currency)}</Text>
            <View style={styles.colStatus}>
              <View style={[styles.statusBadge, STATUS_STYLE[o.paymentStatus] || {}]}>
                <Text>{o.paymentStatus}</Text>
              </View>
            </View>
            <Text style={styles.colNote}>{o.latestNote || '-'}</Text>
          </View>
        ))}
        {orders.length === 0 && (
          <View style={styles.tableRow}><Text>No orders for this day.</Text></View>
        )}

        <View style={styles.footer}>
          <Text>Generated {formatDate(new Date())} — {businessName}</Text>
        </View>
      </Page>
    </Document>
  );
}
