// route.js: which page the console opens on.

/**
 * @param {string} hash     location.hash ("" when the address names no page)
 * @param {{ showGetStarted?:t boolean } | null} program  from /meta
 * @param {string[]} keys   the page keys in navigation order
 * @returns {{ key: string, param: string|null }}
 */
export function pickRoute(hash, program, keys) {
  if (!hash && program?.showGetStarted && keys.includes('start')) return { key: 'start', param: null }; // a new shop starts here
  const [key, param] = (String(hash).replace(/^#\/?/, '') || 'overview').split('/');
  return { key: keys.includes(key) ? key : 'overview', param: param ? decodeURIComponent(param) : null };
}
