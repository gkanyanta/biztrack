// Consultant commission maths — the single source of truth for this backend.
// Kept here because three routes need it (consultants.js, and both the consultant-self and
// admin-impact views in dashboard.js); the Vercel monolith carries its own copy of the same
// logic in api/index.js, so any change here must be mirrored there.

// The slice of a sale that can earn commission. Two rules combine here:
//   1. Only the goods count. The delivery fee billed to the customer (shippingCharge) is
//      pass-through money that pays the courier, so it earns no commission — a K1,000 order
//      with K200 shipping is commissioned as K1,000, not K1,200.
//   2. Only money actually collected counts. A partial payment is prorated across the whole
//      bill, so half-paid means half the goods value is commissionable.
// Returns null for a sale with nothing to commission (zero/negative total).
function commissionableSale(sale) {
  const saleTotal = parseFloat(sale.totalPrice);
  if (!(saleTotal > 0)) return null;
  const goodsTotal = Math.max(0, saleTotal - (parseFloat(sale.shippingCharge) || 0));
  const paidFraction = Math.min(1, Math.max(0, (parseFloat(sale.amountPaid) || 0) / saleTotal));
  return { goodsTotal, paidFraction, collected: goodsTotal * paidFraction };
}

// Commission is always computed live from current Sale state (never persisted per-sale), so
// both rules above apply retroactively to every past cycle as soon as the underlying sale
// data reflects reality — they are not limited to new sales.
function calcCommission(payType, commissionRate, tierThreshold, tierRate, sales) {
  const rate = parseFloat(commissionRate);
  const tRate = parseFloat(tierRate);
  const threshold = parseFloat(tierThreshold) || 0;

  if (payType === 'revenue_pct') {
    let comm = 0;
    for (const sale of sales) {
      const c = commissionableSale(sale);
      if (!c || c.collected <= 0) continue;
      // The tier is judged on the goods value too, so a delivery fee can't push a sale over
      // the threshold and change the rate applied to the whole order.
      const r = (threshold > 0 && tRate > 0 && c.goodsTotal > threshold) ? tRate : rate;
      comm += c.collected * r / 100;
    }
    return Math.round(comm * 100) / 100;
  }

  // per_unit: tiered by cumulative units — first N at base rate, rest at tier rate.
  // Each sale's units are prorated by how much of that sale has actually been paid.
  // Shipping never added units, so this arm is unaffected by the goods-only rule.
  const th = parseInt(tierThreshold) || 50;
  let effectiveUnits = 0;
  for (const sale of sales) {
    const c = commissionableSale(sale);
    if (!c) continue;
    const units = sale.items.reduce((q, i) => q + i.qty, 0);
    effectiveUnits += units * c.paidFraction;
  }
  const comm = effectiveUnits <= th ? effectiveUnits * rate : (th * rate) + ((effectiveUnits - th) * tRate);
  return Math.round(comm * 100) / 100;
}

module.exports = { commissionableSale, calcCommission };
