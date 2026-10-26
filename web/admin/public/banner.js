// banner.js: the notice at the top of every console page when the shop's program cannot run (currency not supported).

import { h } from './esc.js';

/** @param {{ currencySupported?: boolean, currencyMessage?: string|null } | null} program */
export function renderBanner(program) {
  if (!program || program.currencySupported !== false) return h``;
  return h`<div class="banner err" role="alert"><b>Rewards are switched off for this shop.</b> ${program.currencyMessage || 'The shop currency is not supported.'}</div>`;
}
