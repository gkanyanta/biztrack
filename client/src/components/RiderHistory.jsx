import { useState, useEffect } from 'react';
import { getRiders, getRiderHistory, remitDeliveryCash } from '../services/api';
import { formatMoney, formatDate } from '../utils/format';
import LoadingSpinner from './LoadingSpinner';
import toast from 'react-hot-toast';
import {
  FiCalendar, FiCheck, FiAlertCircle, FiChevronDown, FiChevronRight,
  FiTruck, FiFileText, FiXCircle,
} from 'react-icons/fi';

// One rider's record, day by day, for any stretch of days.
//
// Every other screen here answers "what is outstanding right now": open runs, cash not yet
// remitted, reports not yet checked. None of them could answer "what happened on Tuesday". So a
// day that nobody balanced on the day simply disappeared — the rows were in the database and no
// screen would show them. This is the screen that shows them.
//
// A day is settled when he is holding none of our cash and we have checked whatever he reported.
// That is the whole test, and it is the one figure to scan down the page for.

const RANGES = [
  { key: 14, label: 'Last 14 days' },
  { key: 7, label: 'Last 7 days' },
  { key: 30, label: 'Last 30 days' },
  { key: 90, label: 'Last 90 days' },
];

const dayKey = (d) => new Date(d.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);

function Figure({ label, value, tone = 'slate', money = true }) {
  const tones = {
    slate: 'text-gray-800',
    green: 'text-emerald-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
  };
  return (
    <div>
      <div className={`text-lg font-semibold leading-tight ${tones[tone]}`}>{money ? formatMoney(value) : value}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  );
}

// What he said against what the records say. Only worth printing when the two differ.
function Variance({ v }) {
  if (!v) return null;
  const bits = [];
  if (v.deliveriesCompleted !== 0) bits.push(`${v.deliveriesCompleted > 0 ? '+' : ''}${v.deliveriesCompleted} drops`);
  if (Math.abs(v.cashCollected) > 0.01) bits.push(`${v.cashCollected > 0 ? '+' : ''}${formatMoney(v.cashCollected)} cash`);
  if (Math.abs(v.expensesPaid) > 0.01) bits.push(`${v.expensesPaid > 0 ? '+' : ''}${formatMoney(v.expensesPaid)} spent`);
  if (bits.length === 0) return <span className="text-xs text-gray-400">his report matches</span>;
  return (
    <span className="text-xs text-amber-600 flex items-center gap-1">
      <FiAlertCircle size={12} /> he reported {bits.join(', ')} more than the system has
    </span>
  );
}

export default function RiderHistory() {
  const [riders, setRiders] = useState([]);
  const [riderId, setRiderId] = useState('');
  const [days, setDays] = useState(RANGES[0].key);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    getRiders()
      .then(res => {
        setRiders(res.data);
        if (res.data.length && !riderId) setRiderId(res.data[0].id);
        else if (!res.data.length) setLoading(false);
      })
      .catch(() => { toast.error('Could not load who delivers'); setLoading(false); });
  }, []);

  const load = () => {
    if (!riderId) return;
    setLoading(true);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    getRiderHistory(riderId, { from: dayKey(from), to: dayKey(to) })
      .then(res => setData(res.data))
      .catch(() => toast.error('Could not load the history'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [riderId, days]);

  // Settling a past day is the same act as settling today's, so it is the same button.
  const remit = async (d) => {
    setBusy(d.id);
    try {
      await remitDeliveryCash(d.id, true);
      toast.success('Cash recorded against the order');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not record it');
    } finally { setBusy(null); }
  };

  if (loading && !data) return <LoadingSpinner />;

  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={riderId} onChange={e => setRiderId(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800">
          {riders.map(r => <option key={r.id} value={r.id}>{r.name}{r.isActive ? '' : ' (inactive)'}</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-slate-800">
          {RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </div>

      {!riderId ? (
        <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
          <FiTruck className="mx-auto mb-2 text-gray-300" size={30} />
          <p className="text-gray-500 text-sm">Nobody is set up to deliver yet.</p>
        </div>
      ) : !data ? <LoadingSpinner /> : (
        <>
          {/* Where the window stands, and then where he stands overall — the second is a
              running balance and does not belong to these dates. */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <Figure label="Delivered" value={t.delivered} money={false} />
              <Figure label="Failed" value={t.failed} money={false} tone={t.failed ? 'amber' : 'slate'} />
              <Figure label="Cash collected" value={t.cashCollected} />
              <Figure label="Reached the books" value={t.cashRemitted} tone="green" />
              <Figure label="Still in his pocket" value={t.cashStillHeld} tone={t.cashStillHeld > 0 ? 'red' : 'slate'} />
              <Figure label="He paid out" value={t.expenses} tone={t.expenses > 0 ? 'amber' : 'slate'} />
            </div>
            {(t.daysUnsettled > 0 || t.reportsMissing > 0) && (
              <div className="mt-3 pt-3 border-t border-gray-50 text-xs text-amber-700 flex flex-wrap gap-x-4 gap-y-1">
                {t.daysUnsettled > 0 && <span>{t.daysUnsettled} day{t.daysUnsettled === 1 ? '' : 's'} not settled</span>}
                {t.reportsMissing > 0 && <span>{t.reportsMissing} day{t.reportsMissing === 1 ? '' : 's'} he worked without sending a report</span>}
              </div>
            )}
            {data.account && (
              <div className="mt-3 pt-3 border-t border-gray-50 text-xs text-gray-500">
                Overall, all time: he is holding {formatMoney(data.account.holding)}, we owe him {formatMoney(data.account.owedToRider)}
                {' '}— net {parseFloat(data.account.netDue) >= 0 ? 'due from him' : 'due to him'} {formatMoney(Math.abs(parseFloat(data.account.netDue)))}.
              </div>
            )}
          </div>

          {data.days.length === 0 ? (
            <div className="text-center py-14 bg-white rounded-xl border border-gray-100">
              <FiCalendar className="mx-auto mb-2 text-gray-300" size={30} />
              <p className="text-gray-500 text-sm">Nothing recorded for {data.rider.name} in this window.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.days.map(day => {
                const expanded = openDay === day.date;
                return (
                  <div key={day.date} className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                    <button onClick={() => setOpenDay(expanded ? null : day.date)}
                      className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-50 transition-colors">
                      {expanded ? <FiChevronDown className="text-gray-400 shrink-0" size={16} />
                                : <FiChevronRight className="text-gray-400 shrink-0" size={16} />}
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-800 flex items-center gap-2 flex-wrap">
                          {formatDate(day.date)}
                          {day.settled
                            ? <span className="text-[11px] px-2 py-0.5 bg-emerald-50 text-emerald-600 rounded-full flex items-center gap-1"><FiCheck size={10} /> settled</span>
                            : <span className="text-[11px] px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full">needs attention</span>}
                          {data.rider.expectsReports && !day.report && (day.delivered > 0 || day.failed > 0) && (
                            <span className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">no report</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {day.delivered} delivered{day.failed ? `, ${day.failed} failed` : ''}{day.assigned ? `, ${day.assigned} still open` : ''}
                          {day.cashCollected > 0 && ` · ${formatMoney(day.cashCollected)} collected`}
                          {day.cashHeld > 0 && ` · ${formatMoney(day.cashHeld)} not handed over`}
                          {day.expenses > 0 && ` · ${formatMoney(day.expenses)} out of pocket`}
                        </div>
                        <div className="mt-1"><Variance v={day.variance} /></div>
                      </div>
                    </button>

                    {expanded && (
                      <div className="border-t border-gray-50 divide-y divide-gray-50">
                        {day.report && (
                          <div className="p-4 bg-gray-50/50 text-xs text-gray-600 space-y-1">
                            <div className="font-medium text-gray-700 flex items-center gap-1.5">
                              <FiFileText size={12} /> What he reported
                              {day.report.acknowledgedAt
                                ? <span className="text-emerald-600 font-normal">· checked</span>
                                : <span className="text-amber-600 font-normal">· not yet checked</span>}
                            </div>
                            <div>
                              {day.report.deliveriesCompleted} completed, {day.report.deliveriesFailed} failed ·
                              collected {formatMoney(day.report.cashCollected)} ·
                              spent {formatMoney(day.report.expensesPaid)} ·
                              handed over {formatMoney(day.report.cashHandedOver)} ·
                              kept {formatMoney(day.report.closingFloat)}
                            </div>
                          </div>
                        )}

                        {day.deliveries.length === 0 && (
                          <p className="p-4 text-xs text-gray-500">No deliveries on this day — the figures above come from what he spent or reported.</p>
                        )}

                        {day.deliveries.map(d => (
                          <div key={d.id} className="p-4 flex items-start justify-between gap-3 flex-wrap">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-gray-800 flex items-center gap-2 flex-wrap">
                                {d.orderNumber}
                                {d.status === 'Delivered' && <span className="text-[11px] text-emerald-600">delivered</span>}
                                {d.status === 'Failed' && <span className="text-[11px] text-red-600 flex items-center gap-1"><FiXCircle size={10} /> failed</span>}
                                {d.status !== 'Delivered' && d.status !== 'Failed' && <span className="text-[11px] text-amber-600">{d.status === 'PickedUp' ? 'picked up' : 'assigned'}</span>}
                              </div>
                              <div className="text-xs text-gray-500">
                                {d.customerName}{d.customerCity ? ` · ${d.customerCity}` : ''}
                                {d.failureReason ? ` · ${d.failureReason}` : ''}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              {parseFloat(d.cashCollected) > 0 ? (
                                <>
                                  <div className="text-sm font-medium text-gray-800">{formatMoney(d.cashCollected)}</div>
                                  {d.cashRemitted ? (
                                    <div className="text-[11px] text-emerald-600 flex items-center gap-1 justify-end"><FiCheck size={10} /> on the books</div>
                                  ) : (
                                    <button onClick={() => remit(d)} disabled={busy === d.id}
                                      className="mt-1 px-2.5 py-1 bg-slate-800 text-white rounded-lg text-[11px] font-medium disabled:opacity-50">
                                      {busy === d.id ? 'Recording…' : 'Record cash'}
                                    </button>
                                  )}
                                </>
                              ) : (
                                <div className="text-[11px] text-gray-400">no cash</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
