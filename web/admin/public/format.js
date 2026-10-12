// format.js: display helpers. They return plain strings; h`...` escapes them when they are interpolated.

export const P = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');

const SYMBOL = { INR: '₹', USD: '$' };
/** A decimal money string ("1349.91") with the shop's currency: "₹1,349.91". */
export function money(decimal, currency = 'INR') {
  const n = Number(decimal);
  if (!Number.isFinite(n)) return '—';
  const text = n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return (SYMBOL[currency] ?? `${currency} `) + text;
}

const TZ = 'Asia/Kolkata';
export const D = (iso, withYear = false) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: TZ }) : '—');
export const DT = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—');
export const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;
