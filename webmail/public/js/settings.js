// Settings: profile (name + signature on the mailbox identity), password, out of office, preferences.

import * as api from './api.js';
import * as mail from './mail.js';
import { $, $$, h, toast, dialog, savePrefs, initials } from './util.js';
import { t, tx, locale, lang, setLang } from './i18n.js';

let afterProfile = () => {};
const modal = () => $('#settingsModal');
export const isOpen = () => modal().classList.contains('open');

function status(id, msg, ok) {
  const el = $('#' + id);
  el.textContent = msg || '';
  el.className = 'form-status' + (msg ? (ok ? ' ok' : ' err') : '');
}

export function init({ profileChanged }) {
  afterProfile = profileChanged;
  $('#btnSettings').addEventListener('click', () => open());
  $('#settingsClose').addEventListener('click', close);
  modal().addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  modal().addEventListener('mousedown', e => { if (e.target === modal()) close(); });
  for (const b of $$('.stab-btn')) b.addEventListener('click', () => tab(b.dataset.tab));
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#pwForm').addEventListener('submit', changePassword);
  $('#recForm').addEventListener('submit', saveRecovery);
  $('#recConfirmBtn').addEventListener('click', confirmRecovery);
  $('#recResendBtn').addEventListener('click', resendRecoveryCode);
  $('#closeForm').addEventListener('submit', closeAccount);
  $('#closeCancelBtn').addEventListener('click', cancelClosing);
  $('#vacationForm').addEventListener('submit', saveVacation);
  $('#prefsForm').addEventListener('submit', savePreferences);
  $('#twoStepStart').addEventListener('click', startTwoStep);
  $('#twoStepCancel').addEventListener('click', () => { $('#twoStepSetup').classList.add('hidden'); $('#twoStepStart').classList.remove('hidden'); setup = null; });
  $('#twoStepSetup').addEventListener('submit', enableTwoStep);
  $('#twoStepOn').addEventListener('submit', disableTwoStep);
  $('#signOutOthers').addEventListener('click', signOutOthers);
  $('#appPwForm').addEventListener('submit', createAppPassword);
  $('#appPwCopy').addEventListener('click', () => {
    const secret = $('#appPwSecret').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(secret).then(() => toast(t('Copied')), () => {});
  });
}

function mainIdentity() {
  const me = mail.state.user.email.toLowerCase();
  return mail.state.identities.find(i => (i.email || '').toLowerCase() === me) || mail.state.identities[0] || null;
}

export function open(which = 'general') {
  const ident = mainIdentity();
  $('#setProfileEmail').textContent = mail.state.user.email;
  $('#setProfileAvatar').textContent = initials(mail.state.user.name, mail.state.user.email);
  $('#setDisplayName').value = ident ? ident.name || '' : mail.state.user.name;
  $('#setSignature').value = ident ? ident.textSignature || '' : '';
  $('#pwUsername').value = mail.state.user.email;
  const p = mail.state.prefs;
  $('#prefAutoSeen').checked = !!p.autoSeen;
  $('#prefConfirmDelete').checked = !!p.confirmDelete;
  $('#prefRemoteImages').value = p.remoteImages === 'always' ? 'always' : 'ask';
  $('#prefLang').value = lang;
  for (const id of ['profileStatus', 'pwStatus', 'vacStatus', 'twoStepStatus', 'sessionStatus', 'appPwStatus', 'recStatus', 'recConfirmStatus', 'closeStatus']) status(id, '');
  $('#appPwNew').classList.add('hidden'); $('#appPwSecret').textContent = '';
  $('#stab-vacation').classList.toggle('hidden', !api.hasCapability(api.CAP.vacation));
  tab(which);
  modal().classList.add('open');
  modal().setAttribute('aria-hidden', 'false');
  if (api.hasCapability(api.CAP.vacation)) loadVacation();
  loadSecurity();
}

export function close() {
  modal().classList.remove('open');
  modal().setAttribute('aria-hidden', 'true');
  for (const f of ['#pwForm', '#twoStepSetup', '#twoStepOn', '#appPwForm', '#recForm']) $(f).reset();
  $('#recSendPassword').value = ''; $('#recConfirmCode').value = '';
  $('#closeForm').reset();
  $('#appPwNew').classList.add('hidden'); $('#appPwSecret').textContent = '';
  setup = null;
}

function tab(name) {
  for (const b of $$('.stab-btn')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of $$('.tab-content')) t.classList.toggle('active', t.id === 'tab-' + name);
}

async function saveProfile(e) {
  e.preventDefault();
  const ident = mainIdentity();
  const name = $('#setDisplayName').value.trim();
  const textSignature = $('#setSignature').value.replace(/\s+$/, '');
  if (!ident) return status('profileStatus', t('No sending identity exists for this mailbox. Ask your administrator.'), false);
  try {
    const r = await api.call([['Identity/set', { accountId: api.accountId(), update: { [ident.id]: { name, textSignature } } }, 's']]);
    api.checkSet(r.get('s'), 'save your profile');
    await mail.loadIdentities();
    status('profileStatus', t('Saved.'), true);
    afterProfile();
  } catch (err) { status('profileStatus', err.message, false); }
}

async function changePassword(e) {
  e.preventDefault();
  const current = $('#pwCurrent').value, next = $('#pwNew').value, confirm = $('#pwConfirm').value;
  const code = $('#pwCode').value.replace(/\s+/g, '');
  status('pwStatus', '');
  if (next.length < 12) return status('pwStatus', t('The new password must be at least 12 characters.'), false);
  if (next !== confirm) return status('pwStatus', t('The two new passwords do not match.'), false);
  if (next === current) return status('pwStatus', t('The new password must be different from the current one.'), false);
  if (security.twoStep && !/^\d{6}$/.test(code)) return status('pwStatus', t('Enter the 6-digit code from your authenticator app.'), false);
  const btn = $('#pwSubmitBtn');
  btn.disabled = true; btn.textContent = t('Changing…');
  try {
    const r = await api.changePassword(current, next, code);
    $('#pwForm').reset();
    status('pwStatus', r && r.recoveryToConfirm
      ? t('Password changed. Other devices have been signed out. Check your recovery address below and confirm it again.')
      : t('Password changed. Other devices have been signed out.'), true);
    toast(t('Password changed'));
    loadSecurity();
  } catch (err) {
    if (err.data && err.data.needCode) { security.twoStep = true; renderTwoStep(); }
    status('pwStatus', String(err.message).replace(/secret/gi, 'password'), false);
  } finally {
    btn.disabled = false; btn.textContent = t('Change password');
  }
}

/* ——— Security: two-step, signed-in browsers, app passwords ——— */
let security = { twoStep: false, sessions: [], appPasswords: [] };
let setup = null;

async function loadSecurity() {
  try {
    security = await api.account('security');
  } catch (e) {
    if (!(e instanceof api.SessionEndedError)) status('sessionStatus', t('Could not load security settings: {error}', { error: e.message }), false);
    return;
  }
  renderTwoStep(); renderSessions(); renderAppPasswords(); renderSignIns(); renderRecovery();
  try { closing = await api.account('close'); } catch (e) { closing = null; }
  renderClosing();
}

/* ——— Closing the account (people who signed up themselves) ——— */
let closing = null;
const longDate = d => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
function renderClosing() {
  const c = closing;
  $('#closeCard').classList.toggle('hidden', !c);
  if (!c) return;
  const scheduled = c.scheduled;
  $('#closeIntro').textContent = scheduled ? '' : c.canClose
    ? t('Your mailbox, its mail and your own domains are deleted {days} days after you ask. Until then you can still sign in and cancel. Invoices are kept, as the law requires. Download your data first if you want to keep it.', { days: c.closeDays })
    : c.problem;
  $('#closeIntro').classList.toggle('hidden', !!scheduled);
  $('#closeScheduled').classList.toggle('hidden', !scheduled);
  if (scheduled) $('#closeScheduledText').textContent = t('Your account will be deleted on {date}.', { date: longDate(scheduled.deleteAfter) });
  $('#closeForm').classList.toggle('hidden', !c.canClose || !!scheduled);
  $('#closeCodeRow').classList.toggle('hidden', !security || !security.twoStep);
}

async function closeAccount(e) {
  e.preventDefault();
  status('closeStatus', '');
  const confirm = $('#closeConfirm').value.trim(), currentPassword = $('#closePassword').value;
  const code = $('#closeCode').value.replace(/\s+/g, '');
  if (confirm.toLowerCase() !== String(mail.state.user.email || '').toLowerCase()) return status('closeStatus', t('Type your address to confirm.'), false);
  const ok = await dialog({ title: t('Close my account'), text: t('Your mailbox and everything in it will be deleted in {days} days. You can cancel until then.', { days: closing.closeDays }), okLabel: t('Close my account'), danger: true });
  if (!ok) return;
  const btn = $('#closeBtn');
  btn.disabled = true;
  try {
    const r = await api.account('close', { confirm, currentPassword, code });
    closing = r; $('#closeForm').reset();
    renderClosing(); showAccountNotice(r.scheduled);
    status('closeStatus', t('Done. Other browsers were signed out.'), true);
  } catch (err) {
    if (err.data && err.data.needCode) { security.twoStep = true; renderClosing(); }
    status('closeStatus', err.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function cancelClosing() {
  status('closeStatus', '');
  try {
    closing = await api.account('close/cancel', {});
    renderClosing(); showAccountNotice(null);
    status('closeStatus', t('Your account will not be closed.'), true);
  } catch (err) { status('closeStatus', err.message, false); }
}

/** The notice above the message list while the account is being closed. */
export function showAccountNotice(scheduled) {
  const box = $('#accountNotice');
  if (!box) return;
  box.replaceChildren(...(scheduled ? [h('div', { class: 'notice danger', role: 'status' },
    h('span', {}, t('Your account will be deleted on {date}.', { date: longDate(scheduled.deleteAfter) })),
    h('button', { type: 'button', class: 'lh-link', on: { click: () => open('security') } }, t('Cancel closing')))] : []));
  box.classList.toggle('hidden', !scheduled);
}

/* ——— Recovery address ("Forgot password?") ——— */
function renderRecovery() {
  const r = security.recovery;
  $('#recCurrent').textContent = r ? r.email : t('None');
  if (!$('#recEmail').value) $('#recEmail').value = r ? r.email : '';
  const badge = $('#recBadge');
  badge.classList.toggle('hidden', !r);
  badge.classList.toggle('on', !!(r && r.verified));
  badge.textContent = r && r.verified ? t('Confirmed') : t('Not confirmed');
  const note = security.twoStep ? t('With two-step sign-in on, a forgotten password is reset by an administrator, not by email.')
    : !security.passwordReset ? t('"Forgot your password?" is not available yet; your recovery address is kept for when it is.') : '';
  $('#recNote').textContent = note;
  $('#recNote').classList.toggle('hidden', !note);
  // Confirming: a code sent to the address, typed here (only when IRON ID can send mail).
  const confirming = !!(r && !r.verified && security.passwordReset);
  $('#recConfirm').classList.toggle('hidden', !confirming);
  if (confirming) {
    $('#recConfirmText').textContent = r.codeSent
      ? t('We sent a 6-digit code to {address}. Type it here to confirm the address. No password link is sent to an address that is not confirmed.', { address: r.email })
      : t('Send a code to {address} and type it here to confirm the address. No password link is sent to an address that is not confirmed.', { address: r.email });
    $('#recConfirmCodeBox').classList.toggle('hidden', !r.codeSent);
    $('#recConfirmBtn').classList.toggle('hidden', !r.codeSent);
    $('#recResendBtn').textContent = r.codeSent ? t('Send a new code') : t('Send the code');
  }
}

async function confirmRecovery() {
  const code = $('#recConfirmCode').value.replace(/\s+/g, '');
  status('recConfirmStatus', '');
  if (!/^\d{6}$/.test(code)) return status('recConfirmStatus', t('Enter the 6-digit code from the message.'), false);
  const btn = $('#recConfirmBtn');
  btn.disabled = true;
  try {
    const r = await api.account('recovery/confirm', { code });
    security.recovery = r.recovery;
    $('#recConfirmCode').value = '';
    renderRecovery();
    status('recStatus', t('Recovery address confirmed.'), true);
  } catch (err) {
    status('recConfirmStatus', err.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function resendRecoveryCode() {
  status('recConfirmStatus', '');
  const currentPassword = $('#recSendPassword').value;
  if (!currentPassword) return status('recConfirmStatus', t('Enter your password to send a code.'), false);
  const code = $('#recCode').value.replace(/\s+/g, '');
  const btn = $('#recResendBtn');
  btn.disabled = true;
  try {
    const r = await api.account('recovery/code', { currentPassword, code });
    $('#recSendPassword').value = '';
    security.recovery = r.recovery;
    renderRecovery();
    status('recConfirmStatus', t('Code sent. It works for 15 minutes.'), true);
  } catch (err) {
    status('recConfirmStatus', err.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function saveRecovery(e) {
  e.preventDefault();
  const recoveryEmail = $('#recEmail').value.trim(), currentPassword = $('#recPassword').value;
  const code = $('#recCode').value.replace(/\s+/g, '');
  status('recStatus', '');
  if (security.twoStep && !/^\d{6}$/.test(code)) return status('recStatus', t('Enter the 6-digit code from your authenticator app.'), false);
  const btn = $('#recSubmitBtn');
  btn.disabled = true;
  try {
    const r = await api.account('recovery', { recoveryEmail, currentPassword, code });
    security.recovery = r.recovery;
    $('#recPassword').value = ''; $('#recCode').value = '';
    $('#recEmail').value = r.recovery ? r.recovery.email : '';
    renderRecovery();
    const warn = (r.warnings || [])[0];
    status('recStatus', warn || (r.recovery ? (r.recovery.verified ? t('Recovery address saved.') : t('Recovery address saved. Confirm it with the code we send to it.')) : t('Recovery address removed.')), !warn);
  } catch (err) {
    if (err.data && err.data.needCode) { security.twoStep = true; renderTwoStep(); }
    status('recStatus', err.message, false);
  } finally {
    btn.disabled = false;
  }
}

function renderTwoStep() {
  const on = !!security.twoStep;
  const badge = $('#twoStepBadge');
  badge.textContent = on ? t('On') : t('Off');
  badge.classList.toggle('on', on);
  $('#twoStepOff').classList.toggle('hidden', on);
  $('#twoStepOn').classList.toggle('hidden', !on);
  $('#pwCodeRow').classList.toggle('hidden', !on);
  $('#recCodeRow').classList.toggle('hidden', !on);
  $('#closeCodeRow').classList.toggle('hidden', !on);
  if (!on && !setup) { $('#twoStepSetup').classList.add('hidden'); $('#twoStepStart').classList.remove('hidden'); }
}

async function startTwoStep() {
  status('twoStepStatus', '');
  try {
    setup = await api.account('two-step/setup', {});
    $('#twoStepQr').src = setup.qr;
    $('#twoStepSecret').textContent = setup.secret.replace(/(.{4})/g, '$1 ').trim();
    $('#twoStepStart').classList.add('hidden');
    $('#twoStepSetup').classList.remove('hidden');
    $('#twoStepCode').focus();
  } catch (err) { status('twoStepStatus', err.message, false); }
}

async function enableTwoStep(e) {
  e.preventDefault();
  if (!setup) return;
  const code = $('#twoStepCode').value.replace(/\s+/g, ''), password = $('#twoStepPassword').value;
  try {
    await api.account('two-step/enable', { secret: setup.secret, code, password });
    setup = null;
    $('#twoStepSetup').reset();
    security.twoStep = true;
    renderTwoStep();
    status('twoStepStatus', t('Two-step sign-in is on. Next time you sign in, you will be asked for a code.'), true);
    toast(t('Two-step sign-in turned on'));
  } catch (err) { status('twoStepStatus', err.message, false); }
}

async function disableTwoStep(e) {
  e.preventDefault();
  const code = $('#twoStepOffCode').value.replace(/\s+/g, ''), password = $('#twoStepOffPassword').value;
  try {
    await api.account('two-step/disable', { code, password });
    $('#twoStepOn').reset();
    security.twoStep = false;
    renderTwoStep();
    status('twoStepStatus', t('Two-step sign-in is off.'), true);
    toast(t('Two-step sign-in turned off'));
  } catch (err) { status('twoStepStatus', err.message, false); }
}

/** "Chrome on Windows" from a user-agent string. */
function deviceName(ua) {
  const u = String(ua || '');
  if (!u) return t('Unknown browser');
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : t('Browser');
  const os = /iPhone|iPad/.test(u) ? 'iPhone/iPad' : /Android/.test(u) ? 'Android' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '';
  return os ? t('{browser} on {os}', { browser, os }) : browser;
}
const when = d => d ? new Date(d).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

function renderSessions() {
  const list = $('#sessionList');
  const items = (security.sessions || []).map(sx => {
    const li = h('li', {},
      h('div', { class: 'grow' },
        h('div', {}, deviceName(sx.userAgent), sx.current ? h('span', { class: 'this' }, '  · ' + t('This browser')) : null),
        h('div', { class: 'sub' }, [sx.ip, t('last active {time}', { time: when(sx.lastSeen) }), t('signed in {time}', { time: when(sx.createdAt) })].filter(Boolean).join(' · '))));
    if (!sx.current) {
      const b = h('button', { type: 'button', class: 'lh-link' }, t('Sign out'));
      b.addEventListener('click', async () => {
        try { await api.account('sessions/sign-out', { key: sx.key }); toast(t('Signed out')); loadSecurity(); }
        catch (err) { status('sessionStatus', err.message, false); }
      });
      li.append(b);
    }
    return li;
  });
  list.replaceChildren(...(items.length ? items : [h('li', { class: 'muted small' }, t('No other browsers.'))]));
  $('#signOutOthers').disabled = (security.sessions || []).filter(x => !x.current).length === 0;
}

function renderSignIns() {
  const list = $('#signinList');
  const items = (security.recentSignIns || []).map(x => h('li', {},
    h('div', { class: 'grow' },
      h('div', {}, x.ok ? tx('signin', 'Signed in') : t('Failed attempt'), x.ok ? null : h('span', { class: 'danger-text' }, ' · ' + (x.reason === 'code' ? t('wrong code') : t('wrong password'))), ' · ', deviceName(x.agent)),
      h('div', { class: 'sub' }, [when(x.at), x.ip].filter(Boolean).join(' · ')))));
  list.replaceChildren(...(items.length ? items : [h('li', { class: 'muted small' }, t('Nothing recorded yet.'))]));
}

async function signOutOthers() {
  const ok = await dialog({ title: t('Sign out other browsers'), text: t('Every other browser signed in to this mailbox will be signed out. Mail apps using app passwords are not affected.'), okLabel: t('Sign out others') });
  if (!ok) return;
  try { await api.account('sessions/sign-out', { others: true }); toast(t('Other browsers signed out')); loadSecurity(); }
  catch (err) { status('sessionStatus', err.message, false); }
}

function renderAppPasswords() {
  const list = $('#appPwList');
  const items = (security.appPasswords || []).map(a => {
    const b = h('button', { type: 'button', class: 'lh-link danger-text' }, t('Revoke'));
    b.addEventListener('click', async () => {
      const ok = await dialog({ title: t('Revoke app password'), text: t('Apps using "{name}" will stop working until you give them a new app password.', { name: a.name }), okLabel: t('Revoke'), danger: true });
      if (!ok) return;
      try { await api.account('app-passwords/delete', { id: a.id }); toast(t('App password revoked')); loadSecurity(); }
      catch (err) { status('appPwStatus', err.message, false); }
    });
    return h('li', {}, h('div', { class: 'grow' }, h('div', {}, a.name), h('div', { class: 'sub' }, t('Created {time}', { time: when(a.createdAt) }))), b);
  });
  list.replaceChildren(...items);
}

async function createAppPassword(e) {
  e.preventDefault();
  const name = $('#appPwName').value.trim();
  const password = $('#appPwPassword').value;
  status('appPwStatus', '');
  if (!name) return status('appPwStatus', t('Give it a name, for example "Outlook on my laptop".'), false);
  if (!password) return status('appPwStatus', t('Enter your password to confirm.'), false);
  try {
    const r = await api.account('app-passwords', { name, password });
    $('#appPwName').value = ''; $('#appPwPassword').value = '';
    $('#appPwSecret').textContent = r.secret;
    $('#appPwNew').classList.remove('hidden');
    loadSecurity();
  } catch (err) { status('appPwStatus', err.message, false); }
}

/* ——— Out of office (JMAP VacationResponse) ——— */
const VAC_USING = [api.CAP.core, api.CAP.mail, api.CAP.vacation];
async function loadVacation() {
  try {
    const r = await api.call([['VacationResponse/get', { accountId: api.accountId(), ids: ['singleton'] }, 'v']], { using: VAC_USING });
    const v = (r.get('v').list || [])[0] || {};
    $('#vacEnabled').checked = !!v.isEnabled;
    $('#vacFrom').value = v.fromDate ? v.fromDate.slice(0, 10) : '';
    $('#vacTo').value = v.toDate ? v.toDate.slice(0, 10) : '';
    $('#vacSubject').value = v.subject || '';
    $('#vacText').value = v.textBody || '';
  } catch (e) { status('vacStatus', t('Could not load: {error}', { error: e.message }), false); }
}

async function saveVacation(e) {
  e.preventDefault();
  const from = $('#vacFrom').value, to = $('#vacTo').value;
  if (from && to && to < from) return status('vacStatus', t('The end date is before the start date.'), false);
  const enabled = $('#vacEnabled').checked;
  const text = $('#vacText').value.trim();
  if (enabled && !text) return status('vacStatus', t('Write the message people should receive.'), false);
  const patch = {
    isEnabled: enabled,
    fromDate: from ? new Date(from + 'T00:00:00').toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    toDate: to ? new Date(to + 'T23:59:59').toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    subject: $('#vacSubject').value.trim() || null,
    textBody: text || null
  };
  try {
    const r = await api.call([['VacationResponse/set', { accountId: api.accountId(), update: { singleton: patch } }, 's']], { using: VAC_USING });
    api.checkSet(r.get('s'), 'save the automatic reply');
    status('vacStatus', enabled ? t('Automatic reply is on.') : t('Automatic reply is off.'), true);
  } catch (err) { status('vacStatus', err.message, false); }
}

async function savePreferences(e) {
  e.preventDefault();
  const newLang = $('#prefLang').value;
  const p = mail.state.prefs;
  p.autoSeen = $('#prefAutoSeen').checked;
  p.confirmDelete = $('#prefConfirmDelete').checked;
  p.remoteImages = $('#prefRemoteImages').value === 'always' ? 'always' : 'ask';
  savePrefs(p);
  if (newLang !== lang) {
    try {
      await api.account('prefs', { lang: newLang }); // saved to the account; the answer also sets this browser's cookie
    } catch (err) {
      toast(err.message, false);
      return;
    }
    setLang(newLang); // reloads the page in the new language
    return;
  }
  toast(t('Preferences saved'));
  close();
}
