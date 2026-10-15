// format.js: display helpers. They return plain strings; h`...` escapes them when they are interpolated.

export const P = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');

// The shop's currency symbol from its configured ISO code (same logic as web/loyalty/rules/currency.js; the console
// cannot import server modules, and test/loyalty/currency.test.js proves the copies agree). No code, no symbol.
const symbols = new Map();
const isoCode = (code) => { const c = typeof code === 'string' ? code.trim().toUpperCase() : ''; return /^[A-Z]{3}$/.test(c) ? c : null; };
export function currencySymbol(code) {
  const c = isoCode(code);
  if (!c) return '';
  if (!symbols.has(c)) {
    let symbol = c;
    try { symbol = new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'symbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? c; } catch { /* shown as the code */ }
    symbols.set(c, /[A-Za-z]$/.test(symbol) ? `${symbol} ` : symbol);
  }
  return symbols.get(c);
}
/** A decimal money string ("1349.91") with the shop's currency symbol: "₹1,349.91" (INR), "$1,349.91" (USD). */
export function money(decimal, currency) {
  const n = Number(decimal);
  if (!Number.isFinite(n)) return '—';
  const text = Math.abs(n).toLocaleString(isoCode(currency) === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${currencySymbol(currency)}${text}`;
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
