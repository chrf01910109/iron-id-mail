// IRON ID Mail — "Forgot password?": ask for a link sent to the recovery address, then (from the
// link, /forgot#token=…) choose a new password. The token stays in the URL fragment, which browsers
// never send to a server; it is removed from the address bar as soon as it is read.

import { t, lang as pageLang, setLang } from './i18n.js'; // first: translates the page
import { $ } from './util.js';

async function api(path, body) {
  let res;
  try {
    res = await fetch('/recover-api/' + path, body === undefined ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { throw new Error(t('Network problem: the server could not be reached.')); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data.error || t('Server error (HTTP {status})', { status: res.status })), { code: data.code, status: res.status });
  return data;
}

const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
function showError(id, msg) {
  const e = $(id);
  e.className = msg ? 'login-alert' : 'hidden';
  e.textContent = msg || '';
}
function busy(btn, on, label) {
  btn.disabled = on;
  btn.querySelector('span').textContent = label;
}

/* ——— 1. Ask for a link ——— */
$('#fpAsk').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#fpEmail').value.trim();
  showError('#fpAskError', '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('#fpAskError', t('Enter your full IRON ID address, like name@iron-id.io.'));
  const btn = $('#fpAskBtn');
  busy(btn, true, t('Sending…'));
  try {
    await api('request', { email });
    show('#fpAsk', false);
    show('#fpSent');
  } catch (err) {
    showError('#fpAskError', err.message);
  } finally {
    busy(btn, false, t('Send me a link'));
  }
});

/* ——— 2. Choose the new password ——— */
let token = '';
$('#fpShow').addEventListener('change', () => {
  for (const id of ['#fpPw', '#fpPw2']) $(id).type = $('#fpShow').checked ? 'text' : 'password';
});
$('#fpReset').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#fpPw').value, pw2 = $('#fpPw2').value;
  showError('#fpResetError', '');
  if (pw.length < 12) return showError('#fpResetError', t('Use at least 12 characters for your password.'));
  if (pw !== pw2) return showError('#fpResetError', t('The two new passwords do not match.'));
  const btn = $('#fpResetBtn');
  busy(btn, true, t('Saving…'));
  try {
    await api('reset', { token, password: pw });
    show('#fpReset', false);
    show('#fpDone');
  } catch (err) {
    if (err.code === 'expired') { show('#fpReset', false); show('#fpBadLink'); show('#fpAsk'); }
    else showError('#fpResetError', err.message);
  } finally {
    busy(btn, false, t('Save the new password'));
  }
});

for (const b of document.querySelectorAll('.login-lang [data-lang]')) {
  b.setAttribute('aria-pressed', String(b.dataset.lang === pageLang));
  b.addEventListener('click', () => {
    // Keep the link's token across the reload that changes the language.
    if (token) sessionStorage.setItem('iid-reset-token', token);
    setLang(b.dataset.lang);
  });
}

/* ——— Start ——— */
(async () => {
  const m = /(?:^|[#&])token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash);
  token = m ? m[1] : (sessionStorage.getItem('iid-reset-token') || '');
  sessionStorage.removeItem('iid-reset-token');
  if (m) history.replaceState(null, '', location.pathname);

  let cfg = { enabled: false };
  try { cfg = await api('config'); } catch (e) { /* shown as closed */ }
  if (!cfg.enabled) return show('#fpClosed');
  if (!token) { show('#fpAsk'); return setTimeout(() => $('#fpEmail').focus(), 30); }
  try {
    const r = await api('check', { token });
    $('#fpWho').textContent = r.email;
    $('#fpUser').value = r.email;
    show('#fpReset');
    setTimeout(() => $('#fpPw').focus(), 30);
  } catch (err) {
    show('#fpBadLink');
    show('#fpAsk');
  }
})();
