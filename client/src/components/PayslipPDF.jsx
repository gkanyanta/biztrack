import { Document, Page, Text, View, StyleSheet, Image, pdf } from '@react-pdf/renderer';
import { getSettings } from '../services/api';

// The payslip as the Payroll page shows it, on paper: what was earned, what came off and why,
// what was handed over and what is left. Built from the same lines, so it cannot say anything
// the screen does not.

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica' },
  header: { marginBottom: 16, borderBottom: '1 solid #333', paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  logo: { width: 80, height: 80, objectFit: 'contain' },
  headerText: { flex: 1 },
  businessName: { fontSize: 18, fontFamily: 'Helvetica-Bold' },
  docTitle: { fontSize: 14, marginTop: 4, color: '#555' },
  companyDetail: { fontSize: 8, color: '#555', marginTop: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  section: { marginBottom: 12 },
  sectionTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 4, color: '#333', borderBottom: '0.5 solid #ccc', paddingBottom: 3 },
  bold: { fontFamily: 'Helvetica-Bold' },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, paddingHorizontal: 6, borderBottom: '0.5 solid #eee' },
  lineLabel: { flex: 1, paddingRight: 12 },
  subtotal: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, paddingHorizontal: 6, backgroundColor: '#f3f4f6' },
  netRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 8, backgroundColor: '#1e40af', color: 'white', marginTop: 4 },
  dueBox: { backgroundColor: '#fef3c7', padding: 10, marginTop: 10, borderRadius: 4, border: '0.5 solid #fde68a' },
  owedBox: { backgroundColor: '#fef2f2', padding: 10, marginTop: 10, borderRadius: 4, border: '0.5 solid #fecaca' },
  settledBox: { backgroundColor: '#f0fdf4', padding: 10, marginTop: 10, borderRadius: 4, border: '0.5 solid #bbf7d0' },
  draft: { backgroundColor: '#fef3c7', color: '#92400e', padding: 6, marginBottom: 12, textAlign: 'center', fontFamily: 'Helvetica-Bold' },
  note: { color: '#555', fontSize: 9, marginTop: 2 },
  signatures: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 36 },
  signature: { width: '42%', borderTop: '0.5 solid #333', paddingTop: 4, fontSize: 9, color: '#555' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, textAlign: 'center', color: '#999', fontSize: 8, borderTop: '0.5 solid #ddd', paddingTop: 8 },
});

const EARNING_KINDS = ['salary', 'commission', 'arrears', 'bonus', 'refund'];
const PAID_KINDS = ['prepaid', 'advance'];
const DEDUCTION_KINDS = ['recovery', 'deduction', 'loan'];

function formatDate(date) {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Lines({ title, lines, total, totalLabel, money }) {
  if (!lines.length) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {lines.map((l, i) => (
        <View key={i} style={styles.line}>
          <Text style={styles.lineLabel}>{l.label}</Text>
          <Text>{money(l.amount)}</Text>
        </View>
      ))}
      <View style={styles.subtotal}>
        <Text style={styles.bold}>{totalLabel}</Text>
        <Text style={styles.bold}>{money(total)}</Text>
      </View>
    </View>
  );
}

export default function PayslipPDF({ slip, name, jobTitle, periodLabel, periodName, status, finalisedAt, settings = {} }) {
  const currency = settings.currencySymbol || settings.currency || 'K';
  const businessName = settings.businessName || 'Privtech Solutions Limited';
  const money = (amount) => {
    const num = parseFloat(amount) || 0;
    return `${num < 0 ? '-' : ''}${currency}${Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const lines = (slip.lines || []).filter(l => l.kind !== 'baseline');
  const of = (kinds) => lines.filter(l => kinds.includes(l.kind));
  const isDraft = status === 'draft';
  const payments = slip.payments || [];
  const loans = (slip.loans || []).filter(l => l.outstandingAfter > 0);
  const held = slip.held || [];

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
            <Text style={styles.docTitle}>PAYSLIP</Text>
          </View>
        </View>

        {isDraft && <Text style={styles.draft}>DRAFT: this cycle is not finalised and these figures can still change</Text>}

        <View style={styles.section}>
          <View style={styles.row}>
            <Text><Text style={styles.bold}>Name:</Text> {name}</Text>
            <Text><Text style={styles.bold}>Pay cycle:</Text> {periodName} ({periodLabel})</Text>
          </View>
          <View style={styles.row}>
            <Text>{jobTitle ? <><Text style={styles.bold}>Role:</Text> {jobTitle}</> : ''}</Text>
            <Text><Text style={styles.bold}>{isDraft ? 'Printed:' : 'Finalised:'}</Text> {formatDate(isDraft ? new Date() : finalisedAt)}</Text>
          </View>
        </View>

        {slip.broughtForward !== 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Brought forward</Text>
            <View style={styles.line}>
              <Text style={styles.lineLabel}>{slip.broughtForward > 0 ? 'Unpaid from the last cycle' : 'Owed back to the company from the last cycle'}</Text>
              <Text>{money(slip.broughtForward)}</Text>
            </View>
          </View>
        )}

        <Lines title="Earnings" lines={of(EARNING_KINDS)} total={slip.earnings} totalLabel="Total earnings" money={money} />
        <Lines title="Already received during the cycle" lines={of(PAID_KINDS)} total={-slip.alreadyPaid} totalLabel="Total already received" money={money} />
        <Lines title="Deductions" lines={of(DEDUCTION_KINDS)} total={-slip.deductions} totalLabel="Total deductions" money={money} />

        <View style={styles.netRow}>
          <Text style={styles.bold}>NET PAY</Text>
          <Text style={styles.bold}>{money(slip.netPay)}</Text>
        </View>

        {!isDraft && payments.length > 0 && (
          <View style={[styles.section, { marginTop: 12 }]}>
            <Text style={styles.sectionTitle}>Paid</Text>
            {payments.map((p, i) => (
              <View key={i} style={styles.line}>
                <Text style={styles.lineLabel}>
                  {formatDate(p.createdAt)}{p.paymentMethod ? ` · ${p.paymentMethod}` : ''}{p.reference ? ` · ${p.reference}` : ''}
                </Text>
                <Text>{money(p.amount)}</Text>
              </View>
            ))}
          </View>
        )}

        {!isDraft && (
          slip.outstanding < 0 ? (
            <View style={styles.owedBox}>
              <View style={styles.row}>
                <Text style={[styles.bold, { color: '#991b1b' }]}>Owed back to the company, {slip.carried ? 'carried to the next payslip' : 'to come off the next payslip'}</Text>
                <Text style={[styles.bold, { color: '#991b1b' }]}>{money(Math.abs(slip.outstanding))}</Text>
              </View>
            </View>
          ) : slip.outstanding > 0 ? (
            <View style={styles.dueBox}>
              <View style={styles.row}>
                <Text style={[styles.bold, { color: '#92400e' }]}>{slip.carried ? 'Not paid on this payslip, carried to the next one' : 'Still to be paid'}</Text>
                <Text style={[styles.bold, { color: '#92400e' }]}>{money(slip.outstanding)}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.settledBox}>
              <Text style={[styles.bold, { color: '#166534' }]}>Paid in full</Text>
            </View>
          )
        )}

        {(loans.length > 0 || held.length > 0) && (
          <View style={[styles.section, { marginTop: 12 }]}>
            <Text style={styles.sectionTitle}>For your information</Text>
            {loans.map((l, i) => (
              <Text key={`l${i}`} style={styles.note}>Loan, {l.description}: {money(l.outstandingAfter)} left to repay after this payslip.</Text>
            ))}
            {held.map((h, i) => (
              <Text key={`h${i}`} style={styles.note}>Held, to be given back: {h.label}, {money(h.amount)}.</Text>
            ))}
          </View>
        )}

        {!isDraft && (
          <View style={styles.signatures}>
            <Text style={styles.signature}>Paid by</Text>
            <Text style={styles.signature}>Received by</Text>
          </View>
        )}

        <View style={styles.footer}>
          {of(['commission', 'arrears']).length > 0 && (
            <Text>Commission is earned on what customers have paid. Money collected later is paid on the payslip for the cycle it arrives in.</Text>
          )}
          <Text style={{ marginTop: 2 }}>Generated by {businessName} on {formatDate(new Date())}</Text>
        </View>
      </Page>
    </Document>
  );
}

// Build the payslip and hand it to the browser as a download.
export async function downloadPayslip({ slip, name, jobTitle, periodLabel, periodName, status, finalisedAt }) {
  let settings = {};
  try { settings = (await getSettings()).data; } catch { /* the payslip still prints, with the default heading */ }
  const blob = await pdf(
    <PayslipPDF slip={slip} name={name} jobTitle={jobTitle} periodLabel={periodLabel} periodName={periodName}
      status={status} finalisedAt={finalisedAt} settings={settings} />
  ).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Payslip-${name.replace(/\s+/g, '_')}-${periodLabel}${status === 'draft' ? '-DRAFT' : ''}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
