// app.js: the console's shell: login, forced password change, navigation, and the page host.
// All markup is built with h`...` (esc.js); events are delegated (data-act / data-form), never inline.

import { h, mount } from './esc.js';
import { api, embedded, setCsrf, onAuthEvents, newKey } from './api.js';
import { PAGES } from './pages/index.js';
import { renderBanner } from './banner.js';

const root = document.getElementById('app');
const state = { screen: 'loading', admin: null, program: null, route: { key: 'overview', param: null }, toastTimer: null };

const routeFromHash = () => {
  const [key, param] = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  return { key: PAGES.some((p) => p.key === key) ? key : 'overview', param: param ? decodeURIComponent(param) : null };
};
const currentPage = () => PAGES.find((p) => p.key === state.route.key).page;

// ---- views ----

const loginView = (error) => h`<main class="wrap"><div class="card auth-card">
  <div class="brand"><b>ecofynd</b><span>Rewards · Admin</span></div>
  <h1>Sign in</h1>
  <form data-form="login" novalidate>
    <label class="f" for="login-email">Email<input class="inp" id="login-email" name="email" type="email" autocomplete="username" required></label>
    <label class="f" for="login-password">Password<input class="inp" id="login-password" name="password" type="password" autocomplete="current-password" required></label>
    ${error ? h`<div class="err" role="alert">${error}</div>` : ''}
    <button class="btn" type="submit">Sign in</button>
  </form>
  <p class="faint fs-sm">This console is separate from the Shopify admin. Ask the shop owner for an account.</p>
</div></main>`;

const changePasswordView = (forced, error) => h`<main class="wrap"><div class="card auth-card">
  <div class="brand"><b>ecofynd</b><span>Rewards · Admin</span></div>
  <h1>${forced ? 'Choose a new password' : 'Change password'}</h1>
  ${forced ? h`<p class="muted">You signed in with a one-time password. Choose your own before you continue.</p>` : ''}
  <form data-form="change-password" novalidate>
    <label class="f" for="cp-current">Current password<input class="inp" id="cp-current" name="currentPassword" type="password" autocomplete="current-password" required></label>
    <label class="f" for="cp-new">New password (at least 12 characters)<input class="inp" id="cp-new" name="newPassword" type="password" autocomplete="new-password" required></label>
    ${error ? h`<div class="err" role="alert">${error}</div>` : ''}
    <div class="flex"><button class="btn" type="submit">Save password</button>${forced ? '' : h`<button class="btn ghost" type="button" data-act="back">Cancel</button>`}</div>
  </form>
</div></main>`;

// Opened outside the Shopify admin, or the session could not be proven: there is no password to fall back to.
const embeddedProblemView = (message) => h`<main class="wrap"><div class="card auth-card">
  <div class="brand"><b>Reward Points</b></div>
  <h1>Open this app from Shopify</h1>
  <p class="muted">${message}</p>
</div></main>`;

const userBar = () => embedded
  ? h`<div class="topbar-user"><span>${state.admin.shop}</span></div>`
  : h`<div class="topbar-user"><span>${state.admin.email}</span>
      <button class="chip-btn" type="button" data-act="show-change">Change password</button>
      <button class="chip-btn" type="button" data-act="logout">Log out</button></div>`;

const consoleView = () => h`<header class="top"><div class="top-in">
    <div class="brand"><b>ecofynd</b><span>Rewards · Admin</span></div>
    ${userBar()}
  </div></header>
  <main class="wrap">${renderBanner(state.program)}<div class="admin">
    <nav class="anav" aria-label="Admin">${PAGES.map((p) => h`<button type="button" data-act="nav" data-v="${p.key}" ${state.route.key === p.key ? h`aria-current="page"` : ''}>${p.label}</button>`)}</nav>
    <div class="amain" id="page"><p class="muted">Loading…</p></div>
  </div></main>
  <div class="toast-host" id="toast" role="status" aria-live="polite"></div>`;

// ---- host ----

function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  mount(el, h`<div class="toast">${message}</div>`);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => mount(el, h``), 3500);
}

const ctx = () => ({ api, newKey, toast, route: state.route, rerender: renderPage, go: (path) => { location.hash = `#/${path}`; } });

async function renderPage() {
  const host = document.getElementById('page');
  if (!host) return;
  try {
    mount(host, await currentPage().render(ctx()));
  } catch (err) {
    console.error(err);
    mount(host, h`<div class="err" role="alert">This page could not be loaded. Try again.</div>`);
  }
}

function showLogin(error) { state.screen = 'login'; mount(root, loginView(error)); }
function showChange(forced, error) { state.screen = forced ? 'forced' : 'change'; mount(root, changePasswordView(forced, error)); }
async function showConsole() {
  state.screen = 'console';
  state.route = routeFromHash();
  const meta = await api.get('meta'); // the program: its currency (the banner) and, below, its name
  state.program = meta.ok ? meta.data.program ?? null : null;
  mount(root, consoleView());
  await renderPage();
}

function showEmbeddedProblem(message) { state.screen = 'problem'; mount(root, embeddedProblemView(message)); }

async function boot() {
  if (embedded) {
    onAuthEvents({ lost: () => { state.admin = null; showEmbeddedProblem('Your session ended. Reload this page, or open the app again from the Shopify admin.'); } });
    const res = await api.get('session');
    if (!res.ok) return showEmbeddedProblem('This console runs inside the Shopify admin. Open Apps in your Shopify admin and choose this app.');
    state.admin = res.data.admin;
    return showConsole();
  }
  onAuthEvents({ lost: () => { state.admin = null; showLogin('Your session ended. Sign in again.'); }, mustChange: () => showChange(true) });
  const res = await api.get('session');
  if (!res.ok) return showLogin();
  state.admin = res.data.admin;
  setCsrf(res.data.csrfToken);
  if (res.data.mustChangePassword) return showChange(true);
  await showConsole();
}

const LOGIN_ERRORS = {
  INVALID_CREDENTIALS: 'That email and password do not match.',
  TOO_MANY_ATTEMPTS: 'Too many failed attempts. Wait a few minutes and try again.',
  INVALID_REQUEST: 'Enter your email and password.',
  AMBIGUOUS_ADMIN_EMAIL: 'This e-mail address is an admin of more than one shop, so it cannot sign in here. Ask for a different e-mail address for each shop.',
};

const CORE_SUBMIT = {
  async login(form) {
    const body = Object.fromEntries(new FormData(form));
    const res = await api.post('login', body);
    if (!res.ok) return showLogin(LOGIN_ERRORS[res.data.error] || 'Sign-in failed.');
    setCsrf(res.data.csrfToken);
    state.admin = { email: String(body.email).trim() };
    if (res.data.mustChangePassword) return showChange(true);
    await showConsole();
  },
  async 'change-password'(form) {
    const res = await api.post('change-password', Object.fromEntries(new FormData(form)));
    if (!res.ok) {
      const messages = { WRONG_CURRENT_PASSWORD: 'The current password is not right.', TOO_MANY_ATTEMPTS: 'Too many attempts. Wait a few minutes.' };
      return showChange(state.screen === 'forced', res.data.message || messages[res.data.error] || 'The password was not changed.');
    }
    await showConsole();
    toast('Password changed.');
  },
};

const CORE_ACT = {
  async logout() { await api.post('logout', {}); state.admin = null; showLogin(); },
  'show-change'() { showChange(false); },
  async back() { await showConsole(); },
  nav(el) { location.hash = `#/${el.dataset.v}`; },
};

root.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const name = el.dataset.act;
  if (CORE_ACT[name]) { event.preventDefault(); return CORE_ACT[name](el); }
  const handler = state.screen === 'console' ? currentPage().act?.[name] : null;
  if (handler) { event.preventDefault(); await handler(el, ctx(), event); }
});

root.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const name = form.dataset.form;
  if (CORE_SUBMIT[name]) return CORE_SUBMIT[name](form);
  const handler = state.screen === 'console' ? currentPage().submit?.[name] : null;
  if (handler) await handler(form, ctx(), event);
});

root.addEventListener('input', (event) => {
  const el = event.target.closest('[data-input]');
  const handler = el && state.screen === 'console' ? currentPage().input?.[el.dataset.input] : null;
  if (handler) handler(el, ctx(), event);
});

window.addEventListener('hashchange', async () => {
  if (state.screen !== 'console') return;
  state.route = routeFromHash();
  mount(root, consoleView());
  await renderPage();
});

boot();
