// ZRA Smart Invoice: reporting a company's sales to the Zambia Revenue Authority through its
// VSDC (the Virtual Sales Data Controller, ZRA's Java service the business runs), and keeping
// what ZRA hands back so it can be printed on the receipt. (mirrored in api/index.js)
//
// Nothing here runs for a company unless the platform superadmin has switched it on. Field names
// follow ZRA's VSDC API specification v1.0.7 and its published sample requests; the code lists
// (payment types, units) are the parts most worth confirming against the sandbox.
//
// The rules that keep the books straight:
//   - A sale is reported once it is Confirmed, Shipped or Delivered — when stock leaves — and
//     never for anything dated before the company's start date.
//   - The invoice record is written in the same transaction as the sale, so nothing is lost if
//     the VSDC cannot be reached. Sending happens afterwards and is retried; the sale never waits
//     on ZRA and never fails because of it.
//   - Once a sale has an invoice, its figures are fixed. Cancelling it sends a credit note.

const ZRA_ISSUED_STATUSES = ['Confirmed', 'Shipped', 'Delivered'];

// The categories BizTrack can report, and the rate each carries. VAT (A) is included in the
// price, so 16% of a K116 sale is K16. Turnover tax is charged on the business's turnover, not
// on the customer, so a TOT invoice carries no tax amount.
const ZRA_TAX_CATEGORIES = { A: 16, C1: 0, C2: 0, C3: 0, D: 0, E: 0, TOT: 0 };

// Every header bucket saveSales expects, with the rates ZRA's sample requests send. The buckets
// BizTrack never fills still have to be present.
const ZRA_HEADER_BUCKETS = { A: 16, B: 16, C1: 0, C2: 0, C3: 0, D: 0, Rvat: 16, E: 0, F: 10, Ipl1: 5, Ipl2: 0, Tl: 1.5, Ecm: 5, Exeeg: 3, Tot: 0 };
const ZRA_BUCKET_FOR = { A: 'A', C1: 'C1', C2: 'C2', C3: 'C3', D: 'D', E: 'E', TOT: 'Tot' };

// pmtTyCd. Confirm against the VSDC's own code list (code/selectCodes) in the sandbox.
const ZRA_PAYMENT_CODES = { cash: '01', credit: '02', card: '05', mobile: '06', bank: '07' };

const ZRA_TIMEOUT_MS = 8000;
const ZRA_LOCK_MS = 60000;
const ZRA_DELIVERY_ITEM_CODE = 'DELIVERY';
const ZRA_REGISTRAR = 'BizTrack';

const zra_r2 = (n) => Math.round(n * 100) / 100;
const zra_r4 = (n) => Math.round(n * 10000) / 10000;

class ZraProblem extends Error {}

// ---- configuration ----

// What still has to be filled in before the switch can go on. An empty list means ready.
function zra_configProblems(c) {
  const p = [];
  if (!c) return ['Smart Invoice has not been set up'];
  if (!c.vsdcUrl) p.push('the VSDC address');
  else { try { zra_endpoint(c.vsdcUrl); } catch (e) { p.push(e.message); } }
  if (!/^\d{10}$/.test(c.tpin || '')) p.push('a 10-digit TPIN');
  if (!/^\d{3}$/.test(c.branchId || '')) p.push('a 3-digit branch ID');
  if (!c.deviceSerial) p.push('the device serial number');
  if (!ZRA_TAX_CATEGORIES.hasOwnProperty(c.defaultTaxCategory || '')) p.push('a default tax category');
  if (!/^[A-Z]{2}$/.test(c.originCountry || '')) p.push('a two-letter country of origin');
  if (!c.initialisedAt) p.push('initialising the device with ZRA');
  return p;
}

// The VSDC address, checked every time it is used, not only when it is saved: BizTrack's server
// makes this request, so only hosts the platform has approved in ZRA_ALLOWED_HOSTS are reachable.
function zra_endpoint(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new ZraProblem('The VSDC address is not a valid web address'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new ZraProblem('The VSDC address must be a plain http(s) address');
  }
  const allowed = (process.env.ZRA_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(u.hostname.toLowerCase())) {
    throw new ZraProblem(`${u.hostname} is not in ZRA_ALLOWED_HOSTS on the server`);
  }
  return u.toString().replace(/\/$/, '');
}

async function zra_post(config, path, body) {
  const url = zra_endpoint(config.vsdcUrl) + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZRA_TIMEOUT_MS);
  let res;
  try {
    // A redirect is refused rather than followed, so the allow-list cannot be stepped around.
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'manual' });
  } catch (e) {
    return { reached: false, error: e.name === 'AbortError' ? 'The VSDC did not answer in time' : `Could not reach the VSDC (${e.cause?.code || e.message})` };
  } finally { clearTimeout(timer); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) return { reached: false, error: `The VSDC answered HTTP ${res.status}` };
  if (json.resultCd !== '000') return { reached: true, ok: false, code: json.resultCd, error: `ZRA said: ${json.resultMsg || 'refused'} (code ${json.resultCd})`, body: json };
  return { reached: true, ok: true, body: json };
}

// ---- dates, in Zambian time whatever the server's clock is set to ----

function zra_parts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return p;
}
const zra_date = (d) => { const p = zra_parts(d); return `${p.year}${p.month}${p.day}`; };
const zra_dateTime = (d) => { const p = zra_parts(d); return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`; };

function zra_paymentCode(sale) {
  if (sale.paymentType === 'Credit') return ZRA_PAYMENT_CODES.credit;
  const m = (sale.paymentMethod || '').toLowerCase();
  if (/mobile|momo|airtel|mtn|zamtel|lenco/.test(m)) return ZRA_PAYMENT_CODES.mobile;
  if (/card|visa|master/.test(m)) return ZRA_PAYMENT_CODES.card;
  if (/bank|transfer|eft/.test(m)) return ZRA_PAYMENT_CODES.bank;
  return ZRA_PAYMENT_CODES.cash;
}

// ---- the invoice ----

// The sale as ZRA lines: one per item, plus delivery when it was charged. A sale-wide discount is
// shared across the lines by value, so the lines always add up to what the customer paid.
function zra_lines(sale, config) {
  const problems = [];
  const lines = (sale.items || []).map(i => {
    const p = i.product || {};
    const category = p.zraTaxCategory || config.defaultTaxCategory;
    if (!p.zraClassCode) problems.push(`${p.name || 'A product'} has no ZRA item classification code`);
    if (!ZRA_TAX_CATEGORIES.hasOwnProperty(category || '')) problems.push(`${p.name || 'A product'} has an unknown tax category`);
    return {
      productId: p.id, code: p.sku, classCode: p.zraClassCode, kind: '2', category,
      name: [p.name, p.variantLabel].filter(Boolean).join(' - ').slice(0, 200),
      qty: i.qty, price: zra_r2(parseFloat(i.unitPrice)), supply: zra_r2(parseFloat(i.unitPrice) * i.qty),
    };
  });
  const delivery = zra_r2(parseFloat(sale.shippingCharge) || 0);
  if (delivery > 0) {
    if (!config.deliveryClassCode) problems.push('Delivery was charged, but no ZRA classification code is set for delivery');
    lines.push({ productId: null, code: ZRA_DELIVERY_ITEM_CODE, classCode: config.deliveryClassCode, kind: '3', category: config.defaultTaxCategory, name: 'Delivery', qty: 1, price: delivery, supply: delivery });
  }
  if (!lines.length) problems.push('The sale has no items');

  const gross = zra_r2(lines.reduce((s, l) => s + l.supply, 0));
  const discount = zra_r2(parseFloat(sale.discount) || 0);
  if (discount < 0 || discount > gross) problems.push('The discount is larger than the sale');
  let left = discount;
  lines.forEach((l, idx) => {
    const share = idx === lines.length - 1 ? left : zra_r2(gross ? (discount * l.supply) / gross : 0);
    l.discount = Math.min(share, l.supply);
    left = zra_r2(left - l.discount);
    l.total = zra_r2(l.supply - l.discount);
    const rate = ZRA_TAX_CATEGORIES[l.category] || 0;
    l.taxable = rate ? zra_r4(l.total / (1 + rate / 100)) : l.total;
    l.tax = rate ? zra_r4(l.total - l.taxable) : 0;
  });
  const total = zra_r2(lines.reduce((s, l) => s + l.total, 0));
  if (!problems.length && Math.abs(total - parseFloat(sale.totalPrice)) > 0.01) {
    problems.push(`The items come to K${total.toFixed(2)} but the sale total is K${parseFloat(sale.totalPrice).toFixed(2)}`);
  }
  return { lines, problems };
}

function zra_salePayload(doc, sale, config, lines, original) {
  const credit = doc.kind === 'credit_note';
  const now = new Date();
  const header = {};
  for (const [bucket, rate] of Object.entries(ZRA_HEADER_BUCKETS)) {
    const mine = lines.filter(l => ZRA_BUCKET_FOR[l.category] === bucket);
    header[`taxblAmt${bucket}`] = zra_r4(mine.reduce((s, l) => s + l.taxable, 0));
    header[`taxRt${bucket}`] = bucket === 'Tot' ? 0 : rate;
    header[`taxAmt${bucket}`] = zra_r4(mine.reduce((s, l) => s + l.tax, 0));
  }
  return {
    tpin: config.tpin, bhfId: config.branchId,
    ...(credit && { orgSdcId: original.sdcId }),
    orgInvcNo: credit ? original.rcptNo : 0,
    cisInvcNo: doc.invoiceNo,
    custTpin: null, custNm: (sale.customerName || 'Customer').slice(0, 60),
    salesTyCd: 'N', rcptTyCd: credit ? 'R' : 'S', pmtTyCd: zra_paymentCode(sale), salesSttsCd: '02',
    cfmDt: zra_dateTime(now), salesDt: zra_date(new Date(sale.date)),
    stockRlsDt: null, cnclReqDt: null, cnclDt: null,
    rfdDt: credit ? zra_dateTime(now) : null, rfdRsnCd: credit ? config.refundReasonCode : null,
    totItemCnt: lines.length,
    ...header,
    totTaxblAmt: zra_r4(lines.reduce((s, l) => s + l.taxable, 0)),
    totTaxAmt: zra_r4(lines.reduce((s, l) => s + l.tax, 0)),
    cashDcRt: 0, cashDcAmt: 0,
    totAmt: zra_r2(lines.reduce((s, l) => s + l.total, 0)),
    prchrAcptcYn: 'N', remark: credit ? `Cancels ${original.invoiceNo}` : '',
    regrId: ZRA_REGISTRAR, regrNm: ZRA_REGISTRAR, modrId: ZRA_REGISTRAR, modrNm: ZRA_REGISTRAR,
    saleCtyCd: '1', lpoNumber: null, currencyTyCd: 'ZMW', exchangeRt: '1',
    destnCountryCd: '', dbtRsnCd: '', invcAdjustReason: '',
    itemList: lines.map((l, idx) => ({
      itemSeq: idx + 1, itemCd: l.code, itemClsCd: l.classCode, itemNm: l.name, bcd: '',
      pkgUnitCd: config.pkgUnitCode, pkg: 0, qtyUnitCd: config.qtyUnitCode, qty: l.qty, prc: l.price, splyAmt: l.supply,
      dcRt: l.supply ? zra_r2((l.discount / l.supply) * 100) : 0, dcAmt: l.discount,
      isrccCd: '', isrccNm: '', isrcRt: 0, isrcAmt: 0,
      vatCatCd: l.category, exciseTxCatCd: null, tlCatCd: null, iplCatCd: null,
      vatTaxblAmt: l.taxable, vatAmt: l.tax,
      exciseTaxblAmt: 0, tlTaxblAmt: 0, iplTaxblAmt: 0, iplAmt: 0, tlAmt: 0, exciseTxAmt: 0,
      totAmt: l.total,
    })),
  };
}

function zra_itemPayload(config, line) {
  return {
    tpin: config.tpin, bhfId: config.branchId,
    itemCd: line.code, itemClsCd: line.classCode, itemTyCd: line.kind, itemNm: line.name, itemStdNm: null,
    orgnNatCd: config.originCountry, pkgUnitCd: config.pkgUnitCode, qtyUnitCd: config.qtyUnitCode,
    vatCatCd: line.category, iplCatCd: null, tlCatCd: null, exciseTxCatCd: null,
    btchNo: null, bcd: null, dftPrc: line.price, manufacturerTpin: null, manufacturerItemCd: null, rrp: null,
    svcChargeYn: 'N', rentalYn: 'N', addInfo: null, sftyQty: 0, isrcAplcbYn: 'N', useYn: 'Y',
    regrNm: ZRA_REGISTRAR, regrId: ZRA_REGISTRAR, modrNm: ZRA_REGISTRAR, modrId: ZRA_REGISTRAR,
  };
}

// ZRA must know an item before it appears on an invoice. Registered once; if ZRA already has
// it (the code was registered before a classification change), it is updated instead.
async function zra_register(config, line) {
  const body = zra_itemPayload(config, line);
  const saved = await zra_post(config, '/items/saveItem', body);
  if (!saved.reached || saved.ok) return saved;
  const updated = await zra_post(config, '/items/updateItem', body);
  return updated.reached && !updated.ok ? saved : updated;
}

// ---- recording, in the sale's own transaction ----

// Called inside the transaction that saved the sale. Writes the invoice when the sale has
// happened, and the credit note when an invoiced sale is cancelled. A credit note is written
// even if Smart Invoice has since been switched off: an invoice ZRA holds must be cancelled.
// Returns whether it wrote anything.
async function zra_recordSale(tx, companyId, saleId) {
  const sale = await tx.sale.findFirst({ where: { id: saleId, companyId }, select: { id: true, status: true, date: true, orderNumber: true, fiscalDocuments: { select: { kind: true } } } });
  if (!sale) return false;
  const has = (k) => sale.fiscalDocuments.some(d => d.kind === k);
  if (sale.status === 'Cancelled') {
    if (has('invoice') && !has('credit_note')) {
      await tx.fiscalDocument.create({ data: { saleId, kind: 'credit_note', invoiceNo: `${sale.orderNumber}-CN`, companyId } });
      return true;
    }
    return false;
  }
  if (!ZRA_ISSUED_STATUSES.includes(sale.status) || has('invoice')) return false;
  const config = await tx.zraConfig.findUnique({ where: { companyId } });
  if (!config?.enabled) return false;
  if (config.startDate && new Date(sale.date) < new Date(config.startDate)) return false;
  await tx.fiscalDocument.create({ data: { saleId, kind: 'invoice', invoiceNo: sale.orderNumber, companyId } });
  return true;
}

// What a change to a sale would do to an invoice ZRA may already hold. Returns the reason to
// refuse it, or null. change: { delete: true } | { figures: true } | { status: 'X' }
async function zra_refuseChange(prisma, companyId, saleId, change) {
  const docs = await prisma.fiscalDocument.findMany({ where: { saleId, companyId }, select: { kind: true } });
  if (!docs.length) return null;
  const credited = docs.some(d => d.kind === 'credit_note');
  if (change.delete) return 'This sale has a ZRA Smart Invoice, so it cannot be deleted. Cancel it instead and BizTrack sends ZRA a credit note.';
  if (change.figures) return 'This sale has a ZRA Smart Invoice, so its items, prices, discount, delivery charge and date are fixed. Cancel it (BizTrack sends a credit note) and record it again.';
  if (change.status !== undefined) {
    if (credited && change.status !== 'Cancelled') return 'ZRA has a credit note cancelling this sale. Record it again as a new sale.';
    if (!credited && change.status !== 'Cancelled' && !ZRA_ISSUED_STATUSES.includes(change.status)) {
      return `This sale has a ZRA Smart Invoice, so it cannot go back to ${change.status}. Cancel it instead and BizTrack sends ZRA a credit note.`;
    }
  }
  return null;
}

// ---- sending ----

async function zra_settle(prisma, doc, data) {
  await prisma.fiscalDocument.update({ where: { id: doc.id }, data: { ...data, lockedUntil: null } });
}

// Sends one invoice or credit note. Never throws: whatever happens is written on the document.
async function zra_send(prisma, docId, { deadline = Date.now() + 20000, includeFailed = true } = {}) {
  const now = new Date();
  const claimed = await prisma.fiscalDocument.updateMany({
    where: { id: docId, status: { in: includeFailed ? ['pending', 'failed'] : ['pending'] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + ZRA_LOCK_MS) },
  });
  if (!claimed.count) return;
  const doc = await prisma.fiscalDocument.findUnique({ where: { id: docId } });
  const tried = { attempts: doc.attempts + 1, lastAttemptAt: new Date() };
  try {
    const config = await prisma.zraConfig.findUnique({ where: { companyId: doc.companyId } });
    if (!config?.enabled) return zra_settle(prisma, doc, {});
    const setup = zra_configProblems(config);
    if (setup.length) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: `Smart Invoice set-up is missing ${setup.join(', ')}` });

    let original = null;
    if (doc.kind === 'credit_note') {
      original = await prisma.fiscalDocument.findFirst({ where: { saleId: doc.saleId, kind: 'invoice' } });
      // The invoice goes first; the credit note waits for it without counting as an attempt.
      if (original?.status !== 'issued') return zra_settle(prisma, doc, { lastError: 'Waiting for the invoice it cancels to be issued' });
      if (!config.refundReasonCode) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: 'Smart Invoice set-up is missing the credit note reason code' });
    }

    const sale = await prisma.sale.findUnique({ where: { id: doc.saleId }, include: { items: { include: { product: true } } } });
    const { lines, problems } = zra_lines(sale, config);
    if (problems.length) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: problems.join('; ') });

    const done = new Set();
    for (const line of lines) {
      const registered = line.productId ? sale.items.find(i => i.productId === line.productId).product.zraRegisteredAt : config.deliveryRegisteredAt;
      if (registered || done.has(line.code)) continue;
      if (Date.now() > deadline) return zra_settle(prisma, doc, {});
      const r = await zra_register(config, line);
      if (!r.reached) return zra_settle(prisma, doc, { ...tried, status: 'pending', lastError: r.error });
      if (!r.ok) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: `Registering ${line.name}: ${r.error}` });
      done.add(line.code);
      if (line.productId) await prisma.product.update({ where: { id: line.productId }, data: { zraRegisteredAt: new Date() } });
      else await prisma.zraConfig.update({ where: { id: config.id }, data: { deliveryRegisteredAt: new Date() } });
    }

    if (Date.now() > deadline) return zra_settle(prisma, doc, {});
    const payload = zra_salePayload(doc, sale, config, lines, original);
    const r = await zra_post(config, '/trnsSales/saveSales', payload);
    if (!r.reached) return zra_settle(prisma, doc, { ...tried, status: 'pending', lastError: r.error, request: payload });
    if (!r.ok) return zra_settle(prisma, doc, { ...tried, status: 'failed', lastError: r.error, request: payload });
    const d = r.body.data || {};
    const rcptNo = parseInt(d.rcptNo, 10);
    return zra_settle(prisma, doc, {
      ...tried, status: 'issued', lastError: null, request: payload, issuedAt: new Date(),
      rcptNo: Number.isFinite(rcptNo) ? rcptNo : null, sdcId: d.sdcId ?? null, mrcNo: d.mrcNo ?? null,
      intrlData: d.intrlData ?? null, rcptSign: d.rcptSign ?? null, receiptDate: d.vsdcRcptPbctDate ?? null, qrCodeUrl: d.qrCodeUrl ?? null,
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'zra_send_error', docId, message: e.message }));
    return zra_settle(prisma, doc, { ...tried, status: e instanceof ZraProblem ? 'failed' : 'pending', lastError: e instanceof ZraProblem ? e.message : `Unexpected error: ${e.message}` });
  }
}

// Sends what is waiting for a company, oldest first. Without includeFailed only what is merely
// waiting is retried; a refusal stays put until someone has fixed it and asks again.
async function zra_sendWaiting(prisma, companyId, { includeFailed = false, limit = 10, deadline = Date.now() + 20000 } = {}) {
  const docs = await prisma.fiscalDocument.findMany({
    where: { companyId, status: { in: includeFailed ? ['pending', 'failed'] : ['pending'] } },
    orderBy: [{ createdAt: 'asc' }], take: limit, select: { id: true },
  });
  for (const d of docs) {
    if (Date.now() > deadline) break;
    await zra_send(prisma, d.id, { deadline, includeFailed });
  }
}

// After a sale is saved: send its own documents straight away, then a few others that are
// waiting, so a VSDC that was down catches up as soon as the shop is busy again. Never throws.
async function zra_afterSave(prisma, companyId, saleId) {
  try {
    const config = await prisma.zraConfig.findUnique({ where: { companyId }, select: { enabled: true } });
    if (!config?.enabled) return false;
    const mine = await prisma.fiscalDocument.findMany({ where: { saleId, companyId, status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const deadline = Date.now() + 20000;
    for (const d of mine) await zra_send(prisma, d.id, { deadline, includeFailed: false });
    await zra_sendWaiting(prisma, companyId, { limit: 3, deadline });
    return mine.length > 0;
  } catch (e) {
    console.error(JSON.stringify({ event: 'zra_after_save_error', saleId, message: e.message }));
    return false;
  }
}

// What a sale screen or receipt needs to know about its ZRA documents.
const ZRA_DOC_SELECT = { id: true, kind: true, status: true, invoiceNo: true, lastError: true, issuedAt: true, rcptNo: true, sdcId: true, mrcNo: true, intrlData: true, rcptSign: true, receiptDate: true, qrCodeUrl: true };

module.exports = {
  ZRA_ISSUED_STATUSES, ZRA_TAX_CATEGORIES, ZRA_DOC_SELECT,
  zra_configProblems, zra_endpoint, zra_post, zra_lines, zra_salePayload,
  zra_recordSale, zra_refuseChange, zra_send, zra_sendWaiting, zra_afterSave,
};
