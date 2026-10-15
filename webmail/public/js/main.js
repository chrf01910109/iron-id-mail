// IRON ID Mail — webmail entry point: sign-in, wiring, actions, shortcuts, live updates.

import { t, tn, lang as pageLang, setLang } from './i18n.js'; // first: translates the page before anything else runs
import * as api from './api.js';
import * as mail from './mail.js';
import * as sidebar from './sidebar.js';
import * as list from './list.js';
import * as reader from './reader.js';
import * as compose from './compose.js';
import * as settings from './settings.js';
import * as domains from './domains.js';
import { $, toast, dialog, openMenu, isDialogOpen, isMenuOpen, closeMenu, initials, debounce } from './util.js';

const body = document.body;
let started = false;
let events = null;
let pollTimer = null;

/* ——— Sign-in ——— */
function showLogin(prefill = '', message = '') {
  $('#loginEmail').value = prefill || $('#loginEmail').value;
  $('#loginPassword').value = '';
  const a = $('#loginAlert');
  if (message) { a.className = 'login-alert'; a.textContent = message; } else { a.className = 'hidden'; a.textContent = ''; }
  $('#loginCodeRow').classList.add('hidden');
  $('#loginCode').value = '';
  $('#loginScreen').classList.add('open');
  setTimeout(() => ($('#loginEmail').value ? $('#loginPassword') : $('#loginEmail')).focus(), 60);
}
const hideLogin = () => $('#loginScreen').classList.remove('open');

// Language buttons on the sign-in card. The choice is remembered by this browser at once and
// saved to the account when the person signs in.
// The choice counts for 30 minutes, so on a shared computer it does not carry over to the next person.
const LANG_PICKED = 'ironid.langPicked';
const PICK_TTL = 30 * 60 * 1000;
function pickedLang() {
  try {
    const [code, at] = String(sessionStorage.getItem(LANG_PICKED) || '').split('|');
    return code === pageLang && Date.now() - Number(at) < PICK_TTL ? code : '';
  } catch (e) { return ''; }
}
// "Create one" on the sign-in card, only when sign-up is open.
// Its `domain` also tells which mailboxes can add their own domains ("Your domains").
fetch('/signup-api/config', { credentials: 'same-origin' }).then(r => r.json())
  .then(c => { if (c && c.enabled) $('#loginSignup').classList.remove('hidden'); domains.setPlatformDomain(c && c.ownDomains ? c.domain : null); })
  .catch(() => domains.setPlatformDomain(null));
// "Forgot your password?", only when recovery by email is open.
fetch('/recover-api/config', { credentials: 'same-origin' }).then(r => r.json())
  .then(c => { if (c && c.enabled) $('#loginForgot').classList.remove('hidden'); })
  .catch(() => {});

for (const b of document.querySelectorAll('.login-lang [data-lang]')) {
  b.setAttribute('aria-pressed', String(b.dataset.lang === pageLang));
  b.addEventListener('click', () => {
    try { sessionStorage.setItem(LANG_PICKED, b.dataset.lang + '|' + Date.now()); } catch (e) { /* storage blocked */ }
    setLang(b.dataset.lang);
  });
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim(), password = $('#loginPassword').value;
  const codeRow = $('#loginCodeRow');
  const code = codeRow.classList.contains('hidden') ? '' : $('#loginCode').value.replace(/\s+/g, '');
  const btn = $('#loginSubmitBtn');
  btn.disabled = true; btn.querySelector('span').textContent = t('Signing in…');
  $('#loginAlert').className = 'hidden';
  try {
    const data = await api.signIn(email, password, code, pickedLang());
    try { sessionStorage.removeItem(LANG_PICKED); } catch (e) { /* storage blocked */ }
    if (data.lang && data.lang !== pageLang) { window.location.replace('/'); return; } // the account's language: reload in it
    $('#loginPassword').value = '';
    $('#loginCode').value = '';
    codeRow.classList.add('hidden');
    const who = (data.session && data.session.username) || email;
    if (started && mail.state.user.email && who.toLowerCase() !== mail.state.user.email.toLowerCase()) {
      window.location.replace('/'); // a different person: start clean
      return;
    }
    hideLogin();
    await boot();
  } catch (err) {
    const a = $('#loginAlert');
    if (err.mfaRequired) {
      // Password accepted; the account needs the authenticator code.
      const first = codeRow.classList.contains('hidden');
      codeRow.classList.remove('hidden');
      $('#loginCode').value = '';
      setTimeout(() => $('#loginCode').focus(), 30);
      if (first) { a.className = 'login-alert info'; a.textContent = t('Two-step sign-in is on for this mailbox. {message}', { message: err.message }); }
      else { a.className = 'login-alert'; a.textContent = err.message; }
    } else {
      a.className = 'login-alert'; a.textContent = err.message;
    }
  } finally {
    btn.disabled = false; btn.querySelector('span').textContent = t('Sign in');
  }
});

api.onSessionEnded(() => {
  stopLive();
  if (!$('#loginScreen').classList.contains('open')) showLogin(mail.state.user.email, t('Your session has ended. Please sign in again.'));
});

async function signOut() {
  await compose.flush().catch(() => {});
  stopLive();
  await api.signOut();
  try { sessionStorage.clear(); } catch (e) { /* ignore */ }
  window.location.replace('/');
}

/* ——— Start-up ——— */
async function boot() {
  // Older versions kept the password in the browser; remove any leftovers.
  try { sessionStorage.removeItem('iron_id_auth'); localStorage.removeItem('iron_id_auth'); } catch (e) { /* ignore */ }
  let session;
  try { session = await api.loadSession(); }
  catch (e) { setConn(false, t('Offline')); $('#emailList').textContent = e.message; return; }
  if (!session) { showLogin(); return; }
  mail.state.user.email = session.username;
  // Admin access, team mailboxes (with members, for assigning), labels and domain renewal notices.
  let domainNotices = [];
  try {
    const me = await api.account('me');
    // The language saved to the account (changed on another device): switch to it once.
    if (me.lang && me.lang !== pageLang && setLang(me.lang)) return;
    mail.state.teams = me.teams || [];
    mail.state.labels = me.labels || [];
    $('#btnAdmin').classList.toggle('hidden', !me.admin);
    domainNotices = me.domainNotices || [];
  } catch (e) {
    if (e instanceof api.SessionEndedError) return;
    mail.state.teams = []; mail.state.labels = [];
  }
  try {
    await Promise.all([mail.loadMailboxes(), mail.loadIdentities()]);
  } catch (e) {
    if (e instanceof api.SessionEndedError) return;
    toast(t('Could not load your mailbox: {error}', { error: e.message }), false);
    return;
  }
  profileChanged();
  started = true;
  domains.setup({ email: session.username, notices: domainNotices });
  list.renderHeader();
  await mail.loadList();
  mail.loadQuota().then(sidebar.renderQuota);
  startLive();
}

function profileChanged() {
  const me = mail.state.user.email;
  const ident = mail.state.identities.find(i => (i.email || '').toLowerCase() === me.toLowerCase()) || mail.state.identities[0];
  const local = me.split('@')[0];
  mail.state.user.name = (ident && ident.name) || local.charAt(0).toUpperCase() + local.slice(1);
  $('#userAvatar').textContent = initials(mail.state.user.name, me);
  $('#hdrUserName').textContent = mail.state.user.name;
  $('#hdrUserEmail').textContent = me;
  $('#sessionUser').textContent = me;
}

/* ——— Navigation ——— */
function openFolder(id, accountId = null) {
  mail.setView({ accountId: accountId || mail.viewAccount(), mailboxId: id });
  openView();
}

function openLabel(slug) {
  mail.setView({ label: slug });
  openView();
}

function openView() {
  domains.close();
  list.syncFilterTabs();
  mail.state.view.search = '';
  $('#searchInput').value = '';
  mail.state.selected = null;
  body.classList.remove('nav-open');
  $('#navToggle').setAttribute('aria-expanded', 'false');
  showList();
  reader.clear();
  $('#emailList').scrollTop = 0;
  mail.emit('mailboxes');
  mail.loadList();
}

async function openThread(threadId, { focusReader = false } = {}) {
  if (!threadId) return;
  // Drafts open in the composer.
  const rep = mail.state.list.items.find(e => e.threadId === threadId);
  const members = mail.state.list.members.get(threadId) || [];
  if (rep && members.length && members.every(e => e.keywords && e.keywords.$draft)) {
    try {
      const emails = await mail.loadThread(threadId);
      const d = emails[emails.length - 1];
      if (d) { compose.openDraft(d); return; }
    } catch (e) { toast(e.message, false); return; }
  }
  mail.state.selected = threadId;
  list.markSelected(threadId);
  body.classList.add('view-reader'); body.classList.remove('view-list');
  await reader.open(threadId);
  if (focusReader) $('#readerPane').focus();
}

function showList() { body.classList.remove('view-reader'); body.classList.add('view-list'); }

function back() {
  showList();
  list.focusSelected();
}

/* ——— Conversation actions ——— */
function threadEmails({ allInScope = false } = {}) {
  const cur = reader.currentThread();
  if (!cur) return [];
  const v = mail.state.view;
  const shown = cur.shown;
  if (allInScope || mail.state.list.searchAll || !v.mailboxId) return shown;
  const inFolder = shown.filter(e => e.mailboxIds[v.mailboxId]);
  return inFolder.length ? inFolder : shown;
}

/** After a conversation leaves the folder: show the next one (or the list on phones). */
async function advance(threadId) {
  const items = mail.state.list.items;
  const i = items.findIndex(e => e.threadId === threadId);
  const next = items[i + 1] || items[i - 1];
  mail.state.list.items = items.filter(e => e.threadId !== threadId);
  mail.emit('list');
  const narrow = window.matchMedia('(max-width: 860px)').matches;
  if (next && !narrow) await openThread(next.threadId);
  else { mail.state.selected = null; reader.clear(); showList(); }
  mail.loadList();
  mail.refreshCountsSoon();
}

async function moveThread(toId, label, opts = {}) {
  const cur = reader.currentThread();
  if (!cur) return;
  const emails = opts.emails || threadEmails();
  const fromId = mail.state.list.searchAll ? null : (opts.fromId !== undefined ? opts.fromId : mail.state.view.mailboxId);
  try {
    const undo = await mail.moveEmails(emails, toId, { fromId, extra: opts.extra });
    toast(label, true, { label: t('Undo'), run: async () => { try { await undo(); toast(t('Undone')); mail.loadList(); mail.refreshCountsSoon(); } catch (e) { toast(e.message, false); } } });
    await advance(cur.threadId);
  } catch (e) { toast(e.message, false); }
}

async function action(name, anchor) {
  const cur = reader.currentThread();
  if (!cur) return;
  const { roles } = mail.state;
  try {
    if (name === 'archive') {
      const to = await mail.ensureRoleMailbox('archive');
      return moveThread(to, t('Archived'));
    }
    if (name === 'delete') {
      const inTrash = cur.shown.every(e => roles.trash && e.mailboxIds[roles.trash]);
      if (inTrash) {
        if (mail.state.prefs.confirmDelete) {
          const ok = await dialog({ title: t('Delete forever'), text: tn('Permanently delete this message? This cannot be undone.', 'Permanently delete these {n} messages? This cannot be undone.', cur.shown.length), okLabel: t('Delete forever'), danger: true });
          if (!ok) return;
        }
        // Copies also filed in another folder only leave the Trash; the rest are destroyed.
        const onlyTrash = cur.shown.filter(e => Object.keys(e.mailboxIds).every(id => id === roles.trash));
        const alsoElsewhere = cur.shown.filter(e => !onlyTrash.includes(e));
        await mail.destroyEmails(onlyTrash.map(e => e.id));
        if (alsoElsewhere.length) await mail.removeFromMailbox(alsoElsewhere.map(e => e.id), roles.trash);
        toast(t('Deleted forever'));
        return advance(cur.threadId);
      }
      const to = await mail.ensureRoleMailbox('trash');
      return moveThread(to, t('Moved to Trash'));
    }
    if (name === 'restore') {
      const inbox = roles.inbox;
      return moveThread(inbox, t('Moved to Inbox'), { emails: cur.shown.filter(e => e.mailboxIds[roles.trash]), fromId: roles.trash });
    }
    if (name === 'spam') {
      const to = await mail.ensureRoleMailbox('junk');
      return moveThread(to, t('Reported as spam'), { extra: { 'keywords/$junk': true, 'keywords/$notjunk': null } });
    }
    if (name === 'notSpam') {
      return moveThread(roles.inbox, t('Moved to Inbox'), { emails: cur.shown.filter(e => e.mailboxIds[roles.junk]), fromId: roles.junk,
        extra: { 'keywords/$junk': null, 'keywords/$notjunk': true } });
    }
    if (name === 'move') {
      const here = mail.state.view.mailboxId;
      const items = mail.state.mailboxes.filter(m => m.id !== here && m.role !== 'drafts').map(m => ({
        label: mail.mailboxName(m), indent: m.depth, icon: m.role === 'trash' ? 'trash' : m.role === 'junk' ? 'junk' : m.role === 'inbox' ? 'inbox' : m.role === 'archive' ? 'archive' : 'folder',
        run: () => moveThread(m.id, t('Moved to {folder}', { folder: mail.mailboxName(m) }))
      }));
      openMenu(anchor || $('#readerPane .ev-toolbar') || $('#readerPane'), [{ title: t('Move to') }, ...items]);
      return;
    }
    if (name === 'read' || name === 'unread') {
      const own = cur.shown.filter(e => !(e.keywords && e.keywords.$draft));
      const ids = name === 'read' ? own.map(e => e.id) : [own[own.length - 1].id];
      await mail.setKeyword(ids, '$seen', name === 'read');
      for (const e of cur.shown) if (ids.includes(e.id)) { e.keywords = { ...(e.keywords || {}) }; if (name === 'read') e.keywords.$seen = true; else delete e.keywords.$seen; }
      toast(name === 'read' ? t('Marked as read') : t('Marked as unread'));
      if (name === 'unread') { mail.state.selected = null; reader.clear(); showList(); mail.emit('list'); }
      else reader.refresh();
      return;
    }
    if (name === 'star') {
      const flagged = cur.shown.some(e => e.keywords && e.keywords.$flagged);
      const ids = flagged ? cur.shown.filter(e => e.keywords && e.keywords.$flagged).map(e => e.id) : [cur.shown[cur.shown.length - 1].id];
      await mail.setKeyword(ids, '$flagged', !flagged);
      await reader.refresh();
      return;
    }
  } catch (e) { if (!(e instanceof api.SessionEndedError)) toast(e.message, false); }
}

async function dropThread(threadId, toId) {
  const members = (mail.state.list.members.get(threadId) || []).filter(mail.inScope);
  const v = mail.state.view;
  const emails = v.mailboxId && !mail.state.list.searchAll ? members.filter(e => e.mailboxIds[v.mailboxId]) : members;
  if (!emails.length || toId === v.mailboxId) return;
  try {
    const undo = await mail.moveEmails(emails, toId, { fromId: mail.state.list.searchAll ? null : v.mailboxId });
    const mb = mail.state.byId.get(toId);
    toast(t('Moved to {folder}', { folder: mail.mailboxName(mb) }), true, { label: t('Undo'), run: async () => { await undo(); mail.loadList(); mail.refreshCountsSoon(); } });
    if (mail.state.selected === threadId) { mail.state.selected = null; reader.clear(); }
    mail.loadList(); mail.refreshCountsSoon();
  } catch (e) { toast(e.message, false); }
}

/* ——— Live updates (JMAP push), with polling as a fallback ——— */
function setConn(ok, text) {
  $('#connDot').className = 'conn-dot' + (ok ? '' : ' offline');
  $('#connText').textContent = text;
}

const onRemoteChange = debounce(async () => {
  try {
    await mail.loadMailboxes();
    await mail.loadList();
    await reader.refresh();
  } catch (e) { /* next change will retry */ }
}, 600);

function startLive() {
  stopLive();
  setConn(true, t('Online'));
  events = api.openEventSource('Email,Mailbox,Thread,EmailDelivery');
  if (!events) { startPolling(); return; }
  let failures = 0;
  events.addEventListener('open', () => { failures = 0; setConn(true, t('Live')); stopPolling(); });
  const handle = ev => {
    if (!ev.data) return;
    setConn(true, t('Live'));
    try { const d = JSON.parse(ev.data); if (d && d['@type'] === 'StateChange') onRemoteChange(); } catch (e) { /* ping */ }
  };
  events.addEventListener('state', handle);
  events.addEventListener('message', handle);
  events.addEventListener('ping', () => setConn(true, t('Live')));
  events.addEventListener('error', () => {
    failures++;
    setConn(false, t('Reconnecting…'));
    if (events && events.readyState === EventSource.CLOSED || failures > 5) { if (events) events.close(); events = null; startPolling(); }
  });
}

function startPolling() {
  stopPolling();
  setConn(true, t('Online'));
  pollTimer = setInterval(() => { if (!document.hidden) onRemoteChange(); }, 60000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
function stopLive() { if (events) { events.close(); events = null; } stopPolling(); }

document.addEventListener('visibilitychange', () => { if (!document.hidden && started) onRemoteChange(); });

/* ——— Keyboard shortcuts ——— */
document.addEventListener('keydown', e => {
  if (!started || $('#loginScreen').classList.contains('open')) return;
  if (isDialogOpen()) return;
  const outside = !e.target || !e.target.closest || !e.target.closest('.modal-bg');
  if (compose.isOpen()) { if (e.key === 'Escape' && outside) { e.preventDefault(); compose.close(); } return; }
  if (settings.isOpen()) { if (e.key === 'Escape' && outside) { e.preventDefault(); settings.close(); } return; }
  if (isMenuOpen()) { if (e.key === 'Escape') closeMenu(); return; }
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const cur = reader.currentThread();
  const last = cur ? cur.shown.filter(x => !(x.keywords && x.keywords.$draft)).slice(-1)[0] : null;
  const k = e.key;
  const run = fn => { e.preventDefault(); fn(); };
  if (k === 'c') return run(() => compose.open());
  if (domains.isOpen()) return; // the domains page has no message shortcuts
  if (k === '/') return run(() => $('#searchInput').focus());
  if (k === 'j' || k === 'ArrowDown' && t === $('#emailList')) return run(() => { const id = list.step(1); if (id) openThread(id); });
  if (k === 'k' || k === 'ArrowUp' && t === $('#emailList')) return run(() => { const id = list.step(-1); if (id) openThread(id); });
  if (k === 'Escape') return run(() => { if (body.classList.contains('nav-open')) { body.classList.remove('nav-open'); return; } back(); });
  if (!cur) return;
  if (k === 'r' && last) return run(() => compose.openReply('reply', last));
  if (k === 'a' && last) return run(() => compose.openReply('replyAll', last));
  if (k === 'f' && last) return run(() => compose.openReply('forward', last));
  if (k === 'e') return run(() => action('archive'));
  if (k === '#' || k === 'Delete') return run(() => action('delete'));
  if (k === 's') return run(() => action('star'));
  if (k === 'l') return run(() => reader.openLabelMenu());
  if (k === 'v') return run(() => action('move'));
  if (k === 'I' && e.shiftKey) return run(() => action('read'));
  if (k === 'U' && e.shiftKey) return run(() => action('unread'));
});

/* ——— Wiring ——— */
sidebar.init({ openFolder, dropThread, openLabel });
list.init({ openThread });
reader.init({
  back,
  reply: (kind, email) => compose.openReply(kind, email),
  editDraft: email => compose.openDraft(email),
  action
});
compose.init({ sent: () => { mail.loadList(); mail.refreshCountsSoon(); reader.refresh(); } });
settings.init({ profileChanged });
domains.init({ showMail: () => openView() });

$('#btnCompose').addEventListener('click', () => compose.open());
$('#btnSignOut').addEventListener('click', signOut);
$('#btnRefresh').addEventListener('click', async () => {
  const i = $('#refreshIcon');
  i.classList.add('animate-spin');
  try { await mail.loadMailboxes(); await mail.loadList(); await reader.refresh(); mail.loadQuota().then(sidebar.renderQuota); }
  catch (e) { /* shown elsewhere */ }
  setTimeout(() => i.classList.remove('animate-spin'), 400);
});
$('#navToggle').addEventListener('click', () => {
  const open = body.classList.toggle('nav-open');
  $('#navToggle').setAttribute('aria-expanded', String(open));
});
$('#sidebarScrim').addEventListener('click', () => body.classList.remove('nav-open'));

boot();
