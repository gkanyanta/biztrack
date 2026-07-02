import { useEffect, useRef, useState, useCallback } from 'react';
import { getNewOrderNotifications } from '../services/api';
import { formatMoney } from '../utils/format';
import toast from 'react-hot-toast';

const STORAGE_KEY = 'biztrack:lastSeenOrderAt';
const POLL_MS = 30000;

function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } catch { /* audio not available (autoplay policy, unsupported browser) — fail silently */ }
}

// Polls for new online-store orders and surfaces a bell badge + toast + chime.
// Admin-only: caller should only mount this for admin/superadmin roles.
export default function useNewOrderNotifications(enabled) {
  const [count, setCount] = useState(0);
  const toastedIds = useRef(new Set());
  const lastSeenAt = useRef(localStorage.getItem(STORAGE_KEY) || new Date().toISOString());

  const poll = useCallback(() => {
    getNewOrderNotifications(lastSeenAt.current)
      .then(({ data }) => {
        setCount(data.count);
        data.orders.forEach(o => {
          if (toastedIds.current.has(o.id)) return;
          toastedIds.current.add(o.id);
          toast.success(`New order ${o.orderNumber} — ${formatMoney(o.totalPrice)} from ${o.customerName || 'a customer'}`, { duration: 6000, icon: '🛒' });
        });
        if (data.orders.length) playChime();
      })
      .catch(() => { /* polling — ignore transient failures, retry next interval */ });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, poll]);

  const acknowledge = useCallback(() => {
    const now = new Date().toISOString();
    lastSeenAt.current = now;
    localStorage.setItem(STORAGE_KEY, now);
    setCount(0);
  }, []);

  return { count, acknowledge };
}
