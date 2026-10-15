// IRON ID Mail — sign-up page: name@<platform domain> in three steps, then straight into the webmail.
// Everything is checked again on the server; the checks here only guide the person.

import { t, tx, lang as pageLang, setLang } from './i18n.js'; // first: translates the page
import { $, h, debounce } from './util.js';
import { solve } from './sha256.js';

const state = { step: 1, domain: 'iron-id.io', available: false, checked: '', pow: null, powRunning: false, busy: false };
const STEP_TITLES = () => [t('Your address'), t('Password'), tx('step', 'Confirm')];

async function api(path, body) {
  let res;
  try {
    res = await fetch('/signup-api/' + path, body === undefined ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { throw new Error(t('Network problem: the server could not be reached.')); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data.error || t('Server error (HTTP {status})', { status: res.status })), { code: data.code, status: res.status });
  return data;
}

/* ——— Steps ——— */
function showStep(n) {
  state.step = n;
  for (const s of document.querySelectorAll('#suForm [data-step]')) s.classList.toggle('hidden', Number(s.dataset.step) !== n);
  $('#suStepTitle').textContent = STEP_TITLES()[n - 1];
  $('#suStepOf').textContent = t('Step {n} of 3', { n });
  $('#suProgress').style.width = Math.round(n / 3 * 100) + '%';
  $('#suBack').classList.toggle('hidden', n === 1);
  $('#suNext').querySelector('span').textContent = n === 3 ? t('Create my account') : t('Continue');
  showError('');
  updateNext();
  const focus = { 1: $('#suFirst').value ? '#suLocal' : '#suFirst', 2: '#suPw', 3: '#suTerms' }[n];
  setTimeout(() => $(focus).focus(), 30);
  if (n === 3 && !state.pow && !state.powRunning) runPuzzle();
}

function showError(msg) {
  const e = $('#suError');
  e.className = msg ? 'login-alert' : 'hidden';
  e.textContent = msg || '';
}

function ready() {
  if (state.step === 1) return !!$('#suFirst').value.trim() && state.available && state.checked === localValue();
  if (state.step === 2) return $('#suPw').value.length >= 12;
  return !!state.pow && $('#suTerms').checked && !state.busy;
}
function updateNext() {
  const b = $('#suNext');
  b.disabled = !ready();
}

/* ——— Step 1: the address ——— */
const localValue = () => $('#suLocal').value.trim().toLowerCase();

function setStatus(kind, text) {
  const s = $('#suAddrStatus');
  s.className = kind === 'ok' ? 'form-status ok' : kind === 'err' ? 'form-status err' : 'muted small';
  s.textContent = text;
}

const checkAddress = debounce(async () => {
  const local = localValue();
  state.available = false;
  $('#suSuggest').classList.add('hidden');
  if (!local) { setStatus('', ''); updateNext(); return; }
  try {
    const r = await api('check', { local, first: $('#suFirst').value, last: $('#suLast').value });
    if (local !== localValue()) return; // typed on meanwhile
    state.checked = local;
    state.available = !!r.available;
    const email = local + '@' + state.domain;
    if (r.available) setStatus('ok', '✓ ' + t('{email} is available', { email }));
    else if (r.reason === 'format') setStatus('', t('Use 4 to 30 letters, numbers, dots, dashes or underscores. Start and end with a letter or number.'));
    else setStatus('err', r.reason === 'reserved' ? t('{email} is reserved.', { email }) : t('{email} is already taken.', { email }));
    const ideas = r.suggestions || [];
    if (ideas.length) {
      $('#suSuggest').replaceChildren(h('span', { class: 'muted small' }, t('Try one of these:')),
        ...ideas.map(x => h('button', { type: 'button', class: 'preset-btn', on: { click: () => { $('#suLocal').value = x; $('#suLocal').dataset.touched = '1'; checkAddress(); } } }, x + '@' + state.domain)));
      $('#suSuggest').classList.remove('hidden');
    }
  } catch (e) {
    setStatus('err', e.message);
  }
  updateNext();
}, 350);

$('#suLocal').addEventListener('input', () => {
  $('#suLocal').dataset.touched = '1';
  const v = $('#suLocal').value, clean = v.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (v !== clean) $('#suLocal').value = clean;
  state.available = false; updateNext();
  checkAddress();
});
$('#suFirst').addEventListener('input', () => {
  // Suggest an address from the name until the person types their own.
  if (!$('#suLocal').dataset.touched) {
    const strip = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const guess = [strip($('#suFirst').value), strip($('#suLast').value)].filter(Boolean).join('.');
    if (guess.length >= 4) { $('#suLocal').value = guess.slice(0, 30); checkAddress(); }
  }
  updateNext();
});
$('#suLast').addEventListener('input', () => $('#suFirst').dispatchEvent(new Event('input')));

/* ——— Step 2: the password ——— */
function scorePassword(pw) {
  if (!pw) return 0;
  if (pw.length < 8) return 1;
  if (pw.length < 12) return 2;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  return pw.length >= 16 || kinds >= 3 ? 4 : 3;
}
$('#suPw').addEventListener('input', () => {
  const s = scorePassword($('#suPw').value);
  const colors = ['transparent', 'var(--color-danger)', 'var(--color-warning)', 'var(--color-accent)', 'var(--color-success)'];
  const words = ['', t('Too short.'), t('Still too short.'), t('Good.'), t('Strong.')];
  $('#suPwMeter').style.width = s * 25 + '%';
  $('#suPwMeter').style.background = colors[s];
  $('#suPwHelp').textContent = (words[s] ? words[s] + ' ' : '') + t('A short sentence works well. Common and leaked passwords are refused.');
  updateNext();
});
$('#suPwShow').addEventListener('change', () => { $('#suPw').type = $('#suPwShow').checked ? 'text' : 'password'; });

/* ——— Step 3: security check and terms ——— */
async function runPuzzle() {
  state.pow = null; state.powRunning = true;
  $('#suPowBadge').className = 'sec-badge'; $('#suPowBadge').textContent = t('Checking…');
  $('#suPowRun').classList.add('hidden');
  updateNext();
  try {
    const c = await api('challenge');
    const n = await solve(c, f => { $('#suPowStatus').textContent = t('Checking… {pct}%', { pct: Math.round(f * 100) }); });
    if (n === null) throw new Error(t('The security check did not work. Please run it again.'));
    state.pow = { salt: c.salt, challenge: c.challenge, signature: c.signature, number: n };
    $('#suPowBadge').className = 'sec-badge on'; $('#suPowBadge').textContent = t('Passed');
    $('#suPowStatus').textContent = '';
  } catch (e) {
    $('#suPowBadge').className = 'sec-badge'; $('#suPowBadge').textContent = t('Not done');
    $('#suPowStatus').textContent = e.message;
    $('#suPowRun').classList.remove('hidden');
  } finally {
    state.powRunning = false;
    updateNext();
  }
}
$('#suPowRun').addEventListener('click', runPuzzle);
$('#suTerms').addEventListener('change', updateNext);

/* ——— Navigation and create ——— */
$('#suBack').addEventListener('click', () => showStep(Math.max(1, state.step - 1)));
$('#suForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!ready()) return;
  if (state.step === 1) { $('#suAddrShow').textContent = localValue() + '@' + state.domain; return showStep(2); }
  if (state.step === 2) return showStep(3);
  state.busy = true; updateNext();
  $('#suNext').querySelector('span').textContent = t('Creating your mailbox…');
  showError('');
  try {
    const r = await api('create', {
      first: $('#suFirst').value, last: $('#suLast').value, local: localValue(),
      password: $('#suPw').value, recovery: $('#suRecovery').value.trim(),
      acceptTerms: $('#suTerms').checked, pow: state.pow
    });
    $('#suPw').value = '';
    $('#suForm').classList.add('hidden');
    $('#suWelcome').textContent = t('Welcome, {name}', { name: $('#suFirst').value.trim() });
    $('#suReady').textContent = r.signedIn === false
      ? t('Your address {email} is ready. Sign in with it and your new password.', { email: r.email })
      : t('Your address {email} is ready and you are signed in.', { email: r.email });
    $('#suDone').classList.remove('hidden');
    $('.su-open').focus();
  } catch (err) {
    state.pow = null; // a puzzle works once
    if (err.code === 'taken' || err.code === 'address') { state.available = false; showStep(1); checkAddress(); setStatus('err', err.message); return; }
    if (err.code === 'password' || err.code === 'recovery') { showStep(2); showError(err.message); return; }
    if (err.code === 'name') { showStep(1); showError(err.message); return; }
    showError(err.message);
    runPuzzle();
  } finally {
    state.busy = false;
    if (state.step === 3) $('#suNext').querySelector('span').textContent = t('Create my account');
    updateNext();
  }
});

/* ——— Language ——— */
for (const b of document.querySelectorAll('.login-lang [data-lang]')) {
  b.setAttribute('aria-pressed', String(b.dataset.lang === pageLang));
  b.addEventListener('click', () => setLang(b.dataset.lang));
}

/* ——— Start ——— */
(async () => {
  let cfg = { enabled: false };
  try { cfg = await api('config'); } catch (e) { /* shown as closed */ }
  if (!cfg.enabled) { $('#suClosed').classList.remove('hidden'); return; }
  state.domain = cfg.domain || state.domain;
  $('#suDomain').textContent = '@' + state.domain;
  $('#suIntro').textContent = t('Get your address @{domain} now. You can connect your own domain later, after you sign in.', { domain: state.domain });
  $('#suForm').classList.remove('hidden');
  showStep(1);
})();
