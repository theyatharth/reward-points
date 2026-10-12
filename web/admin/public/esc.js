// esc.js: the ONE place values become HTML.
//
// esc(value) escapes & < > " ' ` in a value. h`...` is a tagged template: every ${interpolation} goes through
// esc() unless it is itself the result of h`...` (a fragment that is already safe) or an array of those.
// The only way to put markup on the page is mount(element, fragment), which accepts nothing but a fragment.
// test/loyalty/admin-esc.test.js fails if any template literal in this folder that contains HTML is not an
// h`...` template, if innerHTML is used anywhere but here, or if an attribute is interpolated unquoted.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export const esc = (value) => String(value ?? '').replace(/[&<>"'`]/g, (c) => MAP[c]);

class Safe {
  constructor(html) { this.html = html; }
  toString() { return this.html; }
}

function part(value) {
  if (value instanceof Safe) return value.html;
  if (Array.isArray(value)) return value.map(part).join('');
  return esc(value);
}

/** Tagged template: static text as written, every interpolation escaped (fragments and arrays of fragments pass). */
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Safe(out);
}

export const isSafe = (value) => value instanceof Safe;

/** Replaces an element's content with a fragment. Refuses anything that is not an h`...` result. */
export function mount(element, fragment) {
  if (!(fragment instanceof Safe)) throw new TypeError('mount() takes an h`...` fragment');
  element.innerHTML = fragment.html;
}
