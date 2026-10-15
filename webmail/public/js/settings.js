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
  for (const id of ['profileStatus', 'pwStatus', 'vacStatus', 'twoStepStatus', 'sessionStatus', 'appPwStatus']) status(id, '');
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
  for (const f of ['#pwForm', '#twoStepSetup', '#twoStepOn', '#appPwForm']) $(f).reset();
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
    await api.changePassword(current, next, code);
    $('#pwForm').reset();
    status('pwStatus', t('Password changed. Other devices have been signed out.'), true);
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
  renderTwoStep(); renderSessions(); renderAppPasswords(); renderSignIns();
}

function renderTwoStep() {
  const on = !!security.twoStep;
  const badge = $('#twoStepBadge');
  badge.textContent = on ? t('On') : t('Off');
  badge.classList.toggle('on', on);
  $('#twoStepOff').classList.toggle('hidden', on);
  $('#twoStepOn').classList.toggle('hidden', !on);
  $('#pwCodeRow').classList.toggle('hidden', !on);
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
