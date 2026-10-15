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

/** Seconds as a short age: "12 s ago", "7 min ago", "2 h 5 min ago", "3 days ago". */
export function ago(seconds) {
  const s = Math.max(0, Math.round(Number(seconds)));
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h${min % 60 ? ` ${min % 60} min` : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
