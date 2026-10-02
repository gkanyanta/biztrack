import { useState, useEffect } from 'react';
import { getDeliveryFinances } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import toast from 'react-hot-toast';
import {
  FiTruck, FiAlertCircle, FiTrendingUp, FiTrendingDown, FiUser, FiArrowRight,
} from 'react-icons/fi';
import { Link } from 'react-router-dom';

// Does running our own bike beat paying a courier per drop? The fixed cost is the rider's wage
// plus the bike hire; against it sits the delivery fees actually billed, less whatever the rider
// laid out that the company ended up carrying rather than charging on.

function Card({ label, value, sub, tone = 'slate' }) {
  const tones = { slate: 'text-slate-800', green: 'text-emerald-600', red: 'text-red-600', amber: 'text-amber-600' };
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${tones[tone]}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

function Row({ label, value, tone, indent, note }) {
  const tones = { green: 'text-emerald-600', red: 'text-red-600', amber: 'text-amber-600' };
  return (
    <div className={`flex justify-between items-baseline py-1.5 ${indent ? 'pl-4' : ''}`}>
      <span className={`text-sm ${indent ? 'text-gray-500' : 'text-gray-700'}`}>
        {label}
        {note && <span className="text-xs text-gray-400 ml-1.5">{note}</span>}
      </span>
      <span className={`text-sm font-medium ${tones[tone] || 'text-gray-800'}`}>{value}</span>
    </div>
  );
}

const RANGES = [
  { key: '30', label: 'Last 30 days' },
  { key: '7', label: 'Last 7 days' },
  { key: '90', label: 'Last 90 days' },
];

export default function DeliveryFinances() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('30');

  useEffect(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (parseInt(range, 10) - 1) * 86400000);
    getDeliveryFinances({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) })
      .then(res => setData(res.data))
      .catch(() => toast.error('Could not load delivery finances'))
      .finally(() => setLoading(false));
  }, [range]);

  if (loading) return <LoadingSpinner />;
  if (!data) return null;

  const { cost, income, net, riderAccounts, outstanding } = data;
  const beating = net >= 0;
  const aboveBreakEven = data.breakEvenPerDay != null && data.perDay >= data.breakEvenPerDay;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2"><FiTruck size={16} /> Delivery Finances</h3>
          <p className="text-xs text-gray-400 mt-0.5">{formatDate(data.from)} to {formatDate(data.to)} · {data.days} days</p>
        </div>
        <div className="flex gap-1.5">
          {RANGES.map(r => (
            <button key={r.key} onClick={() => { setRange(r.key); setLoading(true); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ${range === r.key ? 'bg-slate-800 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {data.deliveries === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
          <FiTruck className="mx-auto mb-2 text-gray-300" size={30} />
          <p className="text-sm text-gray-500">No deliveries completed in this window.</p>
          <p className="text-xs text-gray-400 mt-1">
            The bike and the rider still cost {formatMoney(cost.fixedInWindow)} over these {data.days} days,
            so every day without drops is a day that cost money and earned none.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card label="Deliveries made" value={data.deliveries}
              sub={`${data.perDay.toFixed(1)} a day${data.breakEvenPerDay != null ? ` · break-even ${data.breakEvenPerDay.toFixed(1)}` : ''}`}
              tone={aboveBreakEven ? 'green' : 'red'} />
            <Card label="Cost per delivery" value={cost.perDelivery != null ? formatMoney(cost.perDelivery) : '—'}
              sub={`vs ${formatMoney(data.courierFee)} a courier charged`}
              tone={cost.perDelivery != null && cost.perDelivery <= data.courierFee ? 'green' : 'red'} />
            <Card label="Fees billed" value={formatMoney(income.feesBilled)}
              sub={income.perDelivery != null ? `${formatMoney(income.perDelivery)} a drop` : null} />
            <Card label={beating ? 'Net gain' : 'Net cost'} value={formatMoney(Math.abs(net))}
              sub={beating ? 'fees cover the bike' : 'fees do not cover the bike'}
              tone={beating ? 'green' : 'red'} />
          </div>

          <div className={`rounded-lg p-3 text-sm flex items-start gap-2 ${
            data.savingVsCourier >= 0 ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                                      : 'bg-red-50 border border-red-200 text-red-800'}`}>
            {data.savingVsCourier >= 0 ? <FiTrendingUp size={16} className="mt-0.5 shrink-0" /> : <FiTrendingDown size={16} className="mt-0.5 shrink-0" />}
            <span>
              {data.savingVsCourier >= 0
                ? `Doing these ${data.deliveries} drops yourself cost ${formatMoney(Math.abs(data.savingVsCourier))} less than paying a courier ${formatMoney(data.courierFee)} each.`
                : `Paying a courier ${formatMoney(data.courierFee)} a drop would have cost ${formatMoney(Math.abs(data.savingVsCourier))} less than running the bike over this window.`}
              {data.breakEvenPerMonth != null && ` The bike needs about ${Math.round(data.breakEvenPerMonth)} drops a month to wash its face.`}
            </span>
          </div>

          {/* The question the warehouse asks whenever the rider is swamped: send him, or hire a
              car? Our bike is a fixed monthly cost however many drops it does; a hired trip is a
              fare. Only a per-drop figure makes them comparable. */}
          {(cost.courierSplit?.own.drops > 0 || cost.courierSplit?.hired.drops > 0) && (
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">Ourselves, or a hired car?</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500">
                    <tr>
                      <th className="text-left pb-2">Carried by</th>
                      <th className="text-right pb-2">Drops</th>
                      <th className="text-right pb-2">Cost</th>
                      <th className="text-right pb-2">Cost a drop</th>
                      <th className="text-right pb-2">Fees billed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    <tr>
                      <td className="py-2">Us<div className="text-xs text-gray-400">the rider's wage and the bike hire</div></td>
                      <td className="py-2 text-right">{cost.courierSplit.own.drops}</td>
                      <td className="py-2 text-right">{formatMoney(cost.courierSplit.own.cost)}</td>
                      <td className="py-2 text-right font-semibold">
                        {cost.courierSplit.own.costPerDrop != null ? formatMoney(cost.courierSplit.own.costPerDrop) : '—'}
                      </td>
                      <td className="py-2 text-right text-gray-500">{formatMoney(cost.courierSplit.own.feesBilled)}</td>
                    </tr>
                    <tr>
                      <td className="py-2">Hired<div className="text-xs text-gray-400">Yango and the rest, per trip</div></td>
                      <td className="py-2 text-right">{cost.courierSplit.hired.drops}</td>
                      <td className="py-2 text-right">{formatMoney(cost.courierSplit.hired.cost)}</td>
                      <td className="py-2 text-right font-semibold">
                        {cost.courierSplit.hired.costPerDrop != null ? formatMoney(cost.courierSplit.hired.costPerDrop) : '—'}
                      </td>
                      <td className="py-2 text-right text-gray-500">{formatMoney(cost.courierSplit.hired.feesBilled)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {cost.courierSplit.own.costPerDrop != null && cost.courierSplit.hired.costPerDrop != null && (
                <p className={`text-xs mt-2 ${cost.courierSplit.own.costPerDrop <= cost.courierSplit.hired.costPerDrop ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {cost.courierSplit.own.costPerDrop <= cost.courierSplit.hired.costPerDrop
                    ? `Carrying them ourselves is cheaper per drop by ${formatMoney(cost.courierSplit.hired.costPerDrop - cost.courierSplit.own.costPerDrop)} at this volume.`
                    : `Hiring is cheaper per drop by ${formatMoney(cost.courierSplit.own.costPerDrop - cost.courierSplit.hired.costPerDrop)} at this volume — the bike's fixed cost is spread over too few drops.`}
                </p>
              )}
              {data.dispatchedFrom?.length > 1 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs font-medium text-gray-500 mb-1">Where the goods left from</p>
                  {data.dispatchedFrom.map(o => (
                    <div key={o.where} className="flex justify-between text-xs text-gray-600 py-0.5">
                      <span>{o.where === 'warehouse' ? 'The warehouse' : o.where}</span>
                      <span>{o.drops} {o.drops === 1 ? 'drop' : 'drops'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">What it cost</h4>
              <div className="divide-y divide-gray-50">
                <Row label="Rider wage" value={formatMoney(cost.riderMonthly)}
                  note={cost.riderPaidFromPayroll ? 'a month, from payroll' : 'a month, from settings'} />
                <Row label="Bike hire" value={formatMoney(cost.bikeMonthly)} note="a month" />
                <Row label={`Fixed cost over ${data.days} days`} value={formatMoney(cost.fixedInWindow)} />
                <Row label="Rider laid out" value={formatMoney(cost.laidOutByRider)} indent />
                <Row label="Recovered from customers" value={'-' + formatMoney(cost.recoveredFromCustomers)} indent tone="green" />
                <Row label="Carried by the company" value={formatMoney(cost.borneByCompany)} indent tone={cost.borneByCompany > 0 ? 'amber' : undefined} />
                {cost.hiredCourierFares > 0 && (
                  <Row label="Hired courier fares" value={formatMoney(cost.hiredCourierFares)} indent tone="amber" />
                )}
                <div className="pt-1.5 mt-1 border-t border-gray-200">
                  <Row label="Total cost" value={formatMoney(cost.total)} />
                </div>
              </div>
              {!cost.riderPaidFromPayroll && (
                <p className="text-xs text-amber-600 mt-2 flex items-start gap-1">
                  <FiAlertCircle size={12} className="mt-0.5 shrink-0" />
                  No rider is linked to a payroll record, so this uses the figure in Settings. Link the
                  rider on the Payroll page and this follows what you actually pay.
                </p>
              )}
              {cost.byCategory.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs font-medium text-gray-500 mb-1">What the rider spent it on</p>
                  {cost.byCategory.map(c => (
                    <div key={c.category} className="flex justify-between text-xs text-gray-600 py-0.5">
                      <span>{c.category}</span><span>{formatMoney(c.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><FiUser size={14} /> Who is holding our cash</h4>
                {riderAccounts.length === 0 ? (
                  <p className="text-sm text-gray-500">No active riders.</p>
                ) : riderAccounts.map(a => (
                  <div key={a.riderId} className="py-2 border-b border-gray-50 last:border-0">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm font-medium text-gray-800">{a.name}</span>
                      <span className={`text-sm font-semibold ${a.netDue > 0 ? 'text-amber-600' : a.netDue < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {a.netDue > 0 ? `owes ${formatMoney(a.netDue)}`
                          : a.netDue < 0 ? `owed ${formatMoney(Math.abs(a.netDue))}`
                          : 'settled'}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      holding {formatMoney(a.holding)} in unconfirmed collections
                      {a.owedToRider > 0 && ` · ${formatMoney(a.owedToRider)} of his own money out`}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-gray-400 mt-2">
                  Settlement is net — he hands over what he collected less what he laid out.
                </p>
              </div>

              {outstanding.awaitingRechargeCount > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <h4 className="text-sm font-semibold text-amber-800 mb-1 flex items-center gap-1.5"><FiAlertCircle size={14} /> Waiting to be charged on</h4>
                  <p className="text-sm text-amber-800">
                    {outstanding.awaitingRechargeCount} rider {outstanding.awaitingRechargeCount === 1 ? 'expense' : 'expenses'} worth {formatMoney(outstanding.awaitingRechargeAmount)} are
                    marked rechargeable but have not been billed to anyone yet.
                  </p>
                  <Link to="/deliveries" className="text-xs text-amber-900 underline mt-2 inline-flex items-center gap-1">
                    Settle them on the Deliveries page <FiArrowRight size={11} />
                  </Link>
                </div>
              )}

              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">Cash through the rider's hands</h4>
                <Row label="Collected at doors" value={formatMoney(income.cashCollectedAtDoors)} />
                <p className="text-xs text-gray-400 mt-1">
                  Money customers handed over on delivery. Orders paid straight into the company
                  account never pass through him, so they are not counted here.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
