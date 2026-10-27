// ZRA Smart Invoice: off unless the superadmin switches it on, every sale that happens is reported
// once, a cancellation becomes a credit note, and a VSDC that is down or refusing never costs a sale.
const http = require('http');
const { loginAs } = require('../lib/harness');

// A pretend VSDC that answers the way ZRA's does and remembers everything it was sent.
function fakeVsdc() {
  const state = { mode: 'ok', calls: [], rcpt: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const path = req.url.replace(/^\/zravsdc/, '');
      state.calls.push({ path, body: raw ? JSON.parse(raw) : null });
      if (state.mode === 'down') { res.writeHead(503); return res.end('Service Unavailable'); }
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (path === '/trnsSales/saveSales') {
        if (state.mode === 'refuse') return send({ resultCd: '910', resultMsg: 'Request parameter error', data: null });
        state.rcpt++;
        return send({ resultCd: '000', resultMsg: 'It is succeeded', data: {
          rcptNo: state.rcpt, intrlData: `INTRL${state.rcpt}`, rcptSign: `SIGN${state.rcpt}`, vsdcRcptPbctDate: '20261027120000',
          sdcId: 'SDC0010000001', mrcNo: 'WIS01000001', qrCodeUrl: `https://sandbox.example/qr/${state.rcpt}` } });
      }
      return send({ resultCd: '000', resultMsg: 'It is succeeded', data: null });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ state, url: `http://127.0.0.1:${server.address().port}/zravsdc`, close: () => server.close() })));
}

module.exports = {
  name: 'ZRA Smart Invoice',
  seed: 'zra',
  async run({ base, prisma, seed, t }) {
    const { eq, section } = t;
    const vsdc = await fakeVsdc();
    try {
      const [boss, otherboss, root] = await Promise.all(['boss', 'otherboss', 'root'].map(u => loginAs(base, u)));
      const paths = () => vsdc.state.calls.map(c => c.path);
      const lastSale = () => vsdc.state.calls.filter(c => c.path === '/trnsSales/saveSales').pop()?.body;
      const sell = (extra = {}) => boss('POST', '/sales', { items: [{ productId: seed.speakerId, qty: 2, unitPrice: 150 }], customerName: 'Mwila', status: 'Confirmed', paymentType: 'Cash', paymentStatus: 'Paid', ...extra });
      const docs = (sale) => (sale.body.fiscalDocuments || []).map(d => [d.kind, d.status]);
      const zraFor = `/superadmin/companies/${seed.companyId}/zra`;

      section('off unless switched on');
      eq('a company starts with Smart Invoice off', (await boss('GET', '/zra/status')).body.enabled, false);
      const before = await sell();
      eq('its sales are recorded exactly as before, with nothing for ZRA', [before.status, docs(before)], [201, []]);
      eq('and BizTrack never calls a VSDC', vsdc.state.calls.length, 0);
      eq('a company admin cannot reach the switch', (await boss('GET', zraFor)).status, 403);
      eq('nor change where invoices are sent', (await boss('PUT', zraFor, { enabled: true })).status, 403);

      section('the superadmin sets it up');
      eq('it cannot be switched on before it is set up',
        (await root('PUT', zraFor, { enabled: true })).body.error.startsWith('Before switching it on, add the VSDC address'), true);
      eq('a TPIN that is not 10 digits is refused', (await root('PUT', zraFor, { tpin: '12345' })).status, 400);
      eq('so is a tax category ZRA does not have', (await root('PUT', zraFor, { defaultTaxCategory: 'Z' })).status, 400);
      const elsewhere = await root('PUT', zraFor, { vsdcUrl: 'http://10.0.0.5:8080/zravsdc' });
      eq('a VSDC on a host the server has not approved is flagged', elsewhere.body.problems.includes('10.0.0.5 is not in ZRA_ALLOWED_HOSTS on the server'), true);
      const setUp = await root('PUT', zraFor, {
        vsdcUrl: vsdc.url, tpin: '1000000000', branchId: '000', deviceSerial: 'DEV-001', defaultTaxCategory: 'TOT',
        originCountry: 'cn', deliveryClassCode: '78102203', refundReasonCode: '01', startDate: '2026-01-01',
      });
      eq('with everything filled in, only initialising the device is left', setUp.body.problems, ['initialising the device with ZRA']);
      eq('and it is still off', setUp.body.enabled, false);
      eq('…so switching it on is still refused', (await root('PUT', zraFor, { enabled: true })).status, 400);
      const init = await root('POST', `${zraFor}/initialise`);
      eq('initialising sends the TPIN, branch and device serial to the VSDC',
        [init.status, vsdc.state.calls[0]], [200, { path: '/initializer/selectInitInfo', body: { tpin: '1000000000', bhfId: '000', dvcSrlNo: 'DEV-001' } }]);
      const on = await root('PUT', zraFor, { enabled: true });
      eq('then it can be switched on', [on.status, on.body.enabled, on.body.environment], [200, true, 'sandbox']);
      eq("another company's admin still sees it off for them", (await otherboss('GET', '/zra/status')).body.enabled, false);
      vsdc.state.calls.length = 0;

      section('a sale is reported to ZRA');
      const sale = await sell({ shippingCharge: 50, discount: 20, paymentMethod: 'Mobile Money' });
      eq('the sale saves, and comes back with its ZRA invoice issued', [sale.status, docs(sale)], [201, [['invoice', 'issued']]]);
      const inv = sale.body.fiscalDocuments[0];
      eq('carrying what ZRA gave back for the receipt',
        [inv.invoiceNo, inv.rcptNo, inv.sdcId, inv.mrcNo, inv.intrlData, inv.rcptSign, inv.qrCodeUrl],
        [sale.body.orderNumber, 1, 'SDC0010000001', 'WIS01000001', 'INTRL1', 'SIGN1', 'https://sandbox.example/qr/1']);
      eq('the item and delivery were registered with ZRA before the invoice', paths(), ['/items/saveItem', '/items/saveItem', '/trnsSales/saveSales']);
      eq('the item is registered under its SKU and classification',
        (({ itemCd, itemClsCd, itemNm, orgnNatCd, vatCatCd }) => ({ itemCd, itemClsCd, itemNm, orgnNatCd, vatCatCd }))(vsdc.state.calls[0].body),
        { itemCd: 'SPK-1', itemClsCd: '52161512', itemNm: 'Speaker - Black', orgnNatCd: 'CN', vatCatCd: 'TOT' });
      const p = lastSale();
      eq('the invoice is a normal sale, numbered as BizTrack numbers it',
        [p.rcptTyCd, p.salesTyCd, p.cisInvcNo, p.orgInvcNo, p.tpin, p.bhfId, p.custNm, p.pmtTyCd],
        ['S', 'N', sale.body.orderNumber, 0, '1000000000', '000', 'Mwila', '06']);
      eq('the discount is shared across the lines so they add up to what was paid',
        p.itemList.map(l => [l.itemCd, l.qty, l.prc, l.splyAmt, l.dcAmt, l.totAmt]),
        [['SPK-1', 2, 150, 300, 17.14, 282.86], ['DELIVERY', 1, 50, 50, 2.86, 47.14]]);
      eq('turnover tax: the whole K330 is TOT turnover and no tax is charged to the customer',
        [p.totAmt, p.taxblAmtTot, p.taxAmtTot, p.totTaxAmt, p.taxblAmtA, p.itemList.map(l => [l.vatCatCd, l.vatAmt])],
        [330, 330, 0, 0, 0, [['TOT', 0], ['TOT', 0]]]);

      vsdc.state.calls.length = 0;
      const again = await sell();
      eq('an item already registered is not registered again', [docs(again), paths()], [[['invoice', 'issued']], ['/trnsSales/saveSales']]);

      const pending = await sell({ status: 'Pending' });
      eq('an order still pending is not reported', docs(pending), []);
      const confirmed = await boss('PUT', `/sales/${pending.body.id}/status`, { status: 'Confirmed' });
      eq('it is reported the moment it is confirmed', docs(confirmed), [['invoice', 'issued']]);
      eq('a sale dated before the start date is history and is not reported', docs(await sell({ date: '2025-12-15' })), []);

      section('an invoiced sale keeps its figures');
      eq('its items cannot be edited', (await boss('PUT', `/sales/${sale.body.id}`, { items: [{ productId: seed.speakerId, qty: 3, unitPrice: 150 }] })).status, 409);
      eq('nor its discount', (await boss('PUT', `/sales/${sale.body.id}`, { discount: 0 })).status, 409);
      eq('saving the same items again is fine', (await boss('PUT', `/sales/${sale.body.id}`, { items: [{ productId: seed.speakerId, qty: 2, unitPrice: 150 }], discount: 20, shippingCharge: 50 })).status, 200);
      eq('and notes can still change', (await boss('PUT', `/sales/${sale.body.id}`, { notes: 'Collected by her brother' })).status, 200);
      eq('it cannot go back to Pending', (await boss('PUT', `/sales/${sale.body.id}/status`, { status: 'Pending' })).status, 409);
      eq('nor be deleted', (await boss('DELETE', `/sales/${sale.body.id}`)).status, 409);

      section('cancelling sends a credit note');
      const cancelled = await boss('PUT', `/sales/${sale.body.id}/status`, { status: 'Cancelled' });
      eq('the sale is cancelled and the credit note issued', [cancelled.status, docs(cancelled)], [200, [['invoice', 'issued'], ['credit_note', 'issued']]]);
      const cn = lastSale();
      eq('the credit note points at the invoice ZRA issued',
        [cn.rcptTyCd, cn.cisInvcNo, cn.orgInvcNo, cn.orgSdcId, cn.rfdRsnCd, cn.totAmt],
        ['R', `${sale.body.orderNumber}-CN`, 1, 'SDC0010000001', '01', 330]);
      eq('a sale ZRA has a credit note for cannot be revived', (await boss('PUT', `/sales/${sale.body.id}/status`, { status: 'Confirmed' })).status, 409);

      section('when the VSDC is down, the sale still goes through');
      vsdc.state.mode = 'down';
      const offline = await sell();
      const waiting = offline.body.fiscalDocuments[0];
      eq('the sale saves, and its invoice waits', [offline.status, waiting.status, waiting.lastError], [201, 'pending', 'The VSDC answered HTTP 503']);
      const status = (await boss('GET', '/zra/status')).body;
      eq('the office can see it waiting', [status.counts.pending, status.attention.map(a => a.sale.orderNumber)], [1, [offline.body.orderNumber]]);
      vsdc.state.mode = 'ok';
      await sell();
      const caughtUp = await boss('GET', `/sales/${offline.body.id}`);
      eq('the next sale, once the VSDC is back, sends the one that was waiting', docs(caughtUp), [['invoice', 'issued']]);

      section('when something has to be fixed first');
      const noCode = await sell({ items: [{ productId: seed.cableId, qty: 1, unitPrice: 50 }] });
      eq('a product with no ZRA classification is not sent, and says why',
        [noCode.status, docs(noCode), noCode.body.fiscalDocuments[0].lastError], [201, [['invoice', 'failed']], 'Cable has no ZRA item classification code']);
      await boss('PUT', `/products/${seed.cableId}`, { name: 'Cable', zraClassCode: '26121609' });
      const retried = await boss('POST', '/zra/retry');
      eq('once it has a classification, retrying sends it', [retried.body.counts.failed, docs(await boss('GET', `/sales/${noCode.body.id}`))], [0, [['invoice', 'issued']]]);

      vsdc.state.mode = 'refuse';
      const refused = await sell();
      const refusal = refused.body.fiscalDocuments[0];
      eq('a sale ZRA refuses is kept, with ZRA\'s reason', [refused.status, refusal.status, refusal.lastError], [201, 'failed', 'ZRA said: Request parameter error (code 910)']);
      vsdc.state.mode = 'ok';
      const sends = () => vsdc.state.calls.filter(c => c.path === '/trnsSales/saveSales' && c.body.cisInvcNo === refused.body.orderNumber).length;
      const sentBefore = sends();
      await sell();
      eq('a refusal is not resent by itself, in case nothing was fixed', sends(), sentBefore);
      eq("another company cannot retry it", (await otherboss('POST', `/zra/documents/${refusal.id}/retry`)).status, 404);
      await boss('POST', `/zra/documents/${refusal.id}/retry`);
      eq('the office can retry it once it is fixed', docs(await boss('GET', `/sales/${refused.body.id}`)), [['invoice', 'issued']]);

      section('the receipt');
      const receipt = await boss('GET', `/sales/${again.body.id}/receipt`);
      eq('carries the ZRA details to print', (({ status, rcptNo, rcptSign, intrlData, sdcId, mrcNo }) => ({ status, rcptNo, rcptSign, intrlData, sdcId, mrcNo }))(receipt.body.sale.fiscalDocuments[0]),
        { status: 'issued', rcptNo: 2, rcptSign: 'SIGN2', intrlData: 'INTRL2', sdcId: 'SDC0010000001', mrcNo: 'WIS01000001' });

      section('switching it off');
      await root('PUT', zraFor, { enabled: false });
      vsdc.state.calls.length = 0;
      eq('new sales are not reported', docs(await sell()), []);
      const offCancel = await boss('PUT', `/sales/${again.body.id}/status`, { status: 'Cancelled' });
      eq('but cancelling a sale ZRA already holds still records the credit note it owes', docs(offCancel), [['invoice', 'issued'], ['credit_note', 'pending']]);
      eq('without calling the VSDC while it is off', vsdc.state.calls.length, 0);
      eq('changing the TPIN means initialising again', (await root('PUT', zraFor, { tpin: '2000000000' })).body.problems, ['initialising the device with ZRA']);
      eq('and every item is registered afresh', (await prisma.product.count({ where: { companyId: seed.companyId, zraRegisteredAt: { not: null } } })), 0);
    } finally {
      vsdc.close();
    }
  },
};
