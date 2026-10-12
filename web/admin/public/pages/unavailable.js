// A page the design has but this version cannot back with real data. It says so, and says what is missing:
// nothing here is simulated.

import { h } from '../esc.js';

export function unavailable({ title, lede, needs }) {
  return {
    async render() {
      return h`<div><h2>${title}</h2><p class="lede">${lede}</p></div>
        <div class="card unavailable grid g6">
          <b class="h-head">Not available in this version</b>
          <p class="muted">${needs}</p>
          <p class="faint fs-sm">See docs/UI-MAP.md for what each screen needs.</p>
        </div>`;
    },
    act: {},
    submit: {},
  };
}
