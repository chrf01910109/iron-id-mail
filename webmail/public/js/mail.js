// Mail data: folders, conversation list, search and message operations.
// Every change uses JMAP patch syntax ("keywords/$seen", "mailboxIds/<id>") so it only
// touches what it means to change (other flags and folders stay as they are).

import * as api from './api.js';
import { loadPrefs } from './util.js';

export const PAGE_SIZE = 40;
const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
const ROLE_NAMES = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', archive: 'Archive', junk: 'Junk', trash: 'Trash' };

export const LIST_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'subject', 'receivedAt', 'preview', 'hasAttachment', 'size'];
const MEMBER_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'receivedAt', 'hasAttachment'];

export const state = {
  user: { email: '', name: '' },
  identities: [],
  teams: [],   // team mailboxes the person belongs to: {email, name, members}
  labels: [],  // {slug, name, color}
  prefs: loadPrefs(),
  // accountId null = the person's own mailbox; label = a label view (own mailbox, every folder)
  view: { accountId: null, mailboxId: null, label: null, filter: 'all', search: '' },
  list: { items: [], emails: new Map(), members: new Map(), total: 0, position: 0, loading: false, error: null, searchAll: false, terms: [] },
  selected: null // threadId
};

/* Folders of each mail account (own + team mailboxes). state.mailboxes / byId / roles are the viewed account's. */
const folderSets = new Map();
const emptySet = { mailboxes: [], byId: new Map(), roles: {} };
export const viewAccount = () => state.view.accountId || api.accountId();
export const isTeamView = () => !!state.view.accountId && state.view.accountId !== api.accountId();
export function folderSet(acc = viewAccount()) { return folderSets.get(acc) || emptySet; }
Object.defineProperties(state, {
  mailboxes: { get: () => folderSet().mailboxes },
  byId: { get: () => folderSet().byId },
  roles: { get: () => folderSet().roles }
});

/** Changes what is shown: an account's folder, or a label. */
export function setView({ accountId = null, mailboxId = null, label = null }) {
  const own = api.accountId();
  state.view.accountId = accountId && accountId !== own ? accountId : null;
  state.view.label = label || null;
  state.view.mailboxId = label ? null : (mailboxId || folderSet().roles.inbox || (folderSet().mailboxes[0] && folderSet().mailboxes[0].id) || null);
  if (!isTeamView() && state.view.filter === 'mine') state.view.filter = 'all';
  api.setViewAccount(state.view.accountId);
}

/** The team (from the gateway) behind a team mail account, matched by address. */
export function teamFor(accountId) {
  const acc = api.mailAccounts().find(a => a.id === accountId);
  if (!acc) return null;
  const name = acc.name.toLowerCase();
  return state.teams.find(t => t.email === name) || { email: acc.name, name: '', members: [] };
}

/* ——— Tiny event bus ——— */
const handlers = {};
export function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }
export function emit(ev, data) { for (const fn of handlers[ev] || []) { try { fn(data); } catch (e) { console.error(e); } } }

/* ——— Folders ——— */
export function mailboxName(mb) {
  if (!mb) return '';
  return mb.role && ROLE_NAMES[mb.role] && /^(inbox|sent( items| mail)?|drafts?|archives?|junk( mail| e-mail)?|spam|trash|deleted( items| messages)?)$/i.test(mb.name)
    ? ROLE_NAMES[mb.role] : mb.name;
}

/** Loads the folders of every mail account (own and team mailboxes) in one request. */
export async function loadMailboxes() {
  const accs = api.mailAccounts();
  const r = await api.call(accs.map((a, i) => ['Mailbox/get', { accountId: a.id }, 'm' + i]), { allowErrors: true });
  accs.forEach((a, i) => {
    const res = r.get('m' + i);
    if (res && !res.error) folderSets.set(a.id, buildSet(res.list || []));
    else if (a.personal) throw new api.JmapError(res && res.error && res.error.type, res && res.error && res.error.description);
  });
  for (const id of Array.from(folderSets.keys())) if (!accs.some(a => a.id === id)) folderSets.delete(id);
  // A team mailbox that disappeared (membership removed): back to the own Inbox.
  if (state.view.accountId && !folderSets.has(state.view.accountId)) setView({});
  if (!state.view.label && (!state.view.mailboxId || !state.byId.has(state.view.mailboxId))) {
    state.view.mailboxId = state.roles.inbox || (state.mailboxes[0] && state.mailboxes[0].id) || null;
  }
  emit('mailboxes');
}

function buildSet(list) {
  const set = { mailboxes: [], byId: new Map(list.map(m => [m.id, m])), roles: {} };
  for (const m of list) if (m.role && !set.roles[m.role]) set.roles[m.role] = m.id;
  // Tree order: role folders first (fixed order), then the rest by sortOrder and name; children under parents.
  const kids = new Map();
  for (const m of list) {
    const p = m.parentId && set.byId.has(m.parentId) ? m.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(m);
  }
  const rank = m => (m.role && ROLE_ORDER.includes(m.role) ? ROLE_ORDER.indexOf(m.role) : 100);
  const sortFn = (a, b) => rank(a) - rank(b) || (a.sortOrder || 0) - (b.sortOrder || 0) || mailboxName(a).localeCompare(mailboxName(b));
  const out = [];
  const walk = (parent, depth) => {
    for (const m of (kids.get(parent) || []).sort(sortFn)) { out.push({ ...m, depth }); walk(m.id, depth + 1); }
  };
  walk(null, 0);
  set.mailboxes = out;
  return set;
}

export function currentMailbox() { return state.byId.get(state.view.mailboxId) || null; }
export function isRole(mailboxId, role) { return !!mailboxId && state.roles[role] === mailboxId; }

export async function createMailbox(name, parentId = null, accountId = viewAccount()) {
  const r = await api.call([['Mailbox/set', { accountId, create: { n: { name, parentId } } }, 's']]);
  api.checkSet(r.get('s'), 'create the folder');
  await loadMailboxes();
  return r.get('s').created.n.id;
}

export async function renameMailbox(id, name, accountId = viewAccount()) {
  const r = await api.call([['Mailbox/set', { accountId, update: { [id]: { name } } }, 's']]);
  api.checkSet(r.get('s'), 'rename the folder');
  await loadMailboxes();
}

export async function deleteMailbox(id, accountId = viewAccount()) {
  const r = await api.call([['Mailbox/set', { accountId, destroy: [id], onDestroyRemoveEmails: false }, 's']]);
  const res = r.get('s');
  const e = res.notDestroyed && res.notDestroyed[id];
  if (e) {
    if (e.type === 'mailboxHasEmail') throw new Error('This folder still has messages. Move or delete them first.');
    if (e.type === 'mailboxHasChild') throw new Error('This folder has sub-folders. Delete those first.');
    throw new Error(e.description || 'Could not delete the folder (' + e.type + ')');
  }
  if (state.view.mailboxId === id && viewAccount() === accountId) state.view.mailboxId = state.roles.inbox || null;
  await loadMailboxes();
}

/**
 * Returns the id of the folder with this role, creating it if needed (e.g. Archive).
 * personal: in the person's own mailbox (drafts and sent mail), whatever is being viewed.
 */
export async function ensureRoleMailbox(role, { personal = false } = {}) {
  const acc = personal ? api.accountId() : viewAccount();
  const set = () => folderSet(acc);
  if (set().roles[role]) return set().roles[role];
  const r = await api.call([['Mailbox/set', { accountId: acc, create: { n: { name: ROLE_NAMES[role] || role, role } } }, 's']], { allowErrors: true });
  const res = r.get('s');
  if (res && res.created && res.created.n) { await loadMailboxes(); return res.created.n.id; }
  // Could not set the role (some servers refuse): fall back to a plain folder with that name.
  await loadMailboxes();
  const byName = set().mailboxes.find(m => m.name.toLowerCase() === (ROLE_NAMES[role] || role).toLowerCase());
  if (byName) return byName.id;
  const c = await api.call([['Mailbox/set', { accountId: acc, create: { n: { name: ROLE_NAMES[role] || role } } }, 's']]);
  api.checkSet(c.get('s'), 'create the folder');
  await loadMailboxes();
  return c.get('s').created.n.id;
}

/* ——— Search ——— */
function toUtcDate(s, endOfDay) {
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) || String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  const dt = new Date(Date.UTC(+y, +mo - 1, +d + (endOfDay ? 1 : 0)));
  return isNaN(dt) ? null : dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parses the search box. Supports from: to: cc: subject: has:attachment is:unread|read|starred
 * before: after: in:all and "quoted phrases". Returns { cond, all, terms }.
 */
export function parseSearch(q) {
  const cond = {};
  const text = [];
  const terms = [];
  let all = false;
  const re = /(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    if (m[1]) {
      const key = m[1].toLowerCase();
      const val = (m[2] !== undefined ? m[2] : m[3]) || '';
      const lv = val.toLowerCase();
      if (['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key) && val) { cond[key] = val; terms.push(val); continue; }
      if (key === 'has' && /^attach/.test(lv)) { cond.hasAttachment = true; continue; }
      if (key === 'is' && lv === 'unread') { cond.notKeyword = '$seen'; continue; }
      if (key === 'is' && lv === 'read') { cond.hasKeyword = '$seen'; continue; }
      if (key === 'is' && (lv === 'starred' || lv === 'flagged')) { cond.hasKeyword = '$flagged'; continue; }
      if (key === 'before' && toUtcDate(val)) { cond.before = toUtcDate(val); continue; }
      if (key === 'after' && toUtcDate(val)) { cond.after = toUtcDate(val, false); continue; }
      if (key === 'in' && (lv === 'all' || lv === 'anywhere')) { all = true; continue; }
      text.push(m[0]); terms.push(m[0]);
    } else {
      const t = m[4] !== undefined ? m[4] : m[5];
      if (t) { text.push(m[4] !== undefined ? `"${t}"` : t); terms.push(t); }
    }
  }
  if (text.length) cond.text = text.join(' ');
  return { cond, all, terms };
}

/** The JMAP filter for the current folder, quick filter and search. */
export function currentFilter() {
  const v = state.view;
  const conds = [];
  let all = false, terms = [];
  if (v.search.trim()) {
    const p = parseSearch(v.search);
    all = p.all; terms = p.terms;
    if (Object.keys(p.cond).length) conds.push(p.cond);
  }
  if (all || !v.mailboxId) {
    const skip = [state.roles.trash, state.roles.junk].filter(Boolean);
    if (skip.length) conds.push({ inMailboxOtherThan: skip });
  } else {
    conds.push({ inMailbox: v.mailboxId });
  }
  if (v.label) conds.push({ hasKeyword: 'label:' + v.label });
  if (v.filter === 'unread') conds.push({ notKeyword: '$seen' });
  if (v.filter === 'starred') conds.push({ hasKeyword: '$flagged' });
  if (v.filter === 'mine' && isTeamView()) conds.push({ hasKeyword: assignedKeyword(state.user.email) });
  const filter = conds.length === 1 ? conds[0] : { operator: 'AND', conditions: conds };
  return { filter, all, terms };
}

/* ——— Conversation list ——— */
/** Which emails of a thread count in the current view (Trash/Junk only when looking at them). */
export function inScope(email) {
  const v = state.view;
  const lookingAtBin = isRole(v.mailboxId, 'trash') || isRole(v.mailboxId, 'junk');
  if (lookingAtBin && !state.list.searchAll) return !!email.mailboxIds[v.mailboxId];
  const bins = [state.roles.trash, state.roles.junk].filter(Boolean);
  return !Object.keys(email.mailboxIds || {}).every(id => bins.includes(id));
}

let listSeq = 0;
/** Loads the first page (append=false) or the next page of conversations. */
export async function loadList({ append = false } = {}) {
  const L = state.list;
  const seq = ++listSeq;
  const position = append ? L.position : 0;
  const { filter, all, terms } = currentFilter();
  L.loading = true;
  emit('list-loading');
  try {
    const acc = viewAccount();
    const r = await api.call([
      ['Email/query', { accountId: acc, filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position, limit: PAGE_SIZE, calculateTotal: true }, 'q'],
      ['Email/get', { accountId: acc, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: LIST_PROPS }, 'g'],
      ['Thread/get', { accountId: acc, '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
      ['Email/get', { accountId: acc, '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: MEMBER_PROPS }, 'm']
    ], { allowErrors: true });
    if (seq !== listSeq) return; // a newer load started
    const q = r.get('q');
    if (!q || q.error) throw new api.JmapError(q && q.error.type, q && q.error.description);
    const got = r.get('g');
    if (!got || got.error) throw new api.JmapError(got && got.error.type, got && got.error.description);
    const byId = new Map(got.list.map(e => [e.id, e]));
    const threads = r.get('t');
    const members = r.get('m');
    const memberById = new Map((members && !members.error ? members.list : []).map(e => [e.id, e]));
    const threadEmails = new Map();
    for (const t of (threads && !threads.error ? threads.list : [])) {
      threadEmails.set(t.id, t.emailIds.map(id => memberById.get(id)).filter(Boolean));
    }
    const items = q.ids.map(id => byId.get(id)).filter(Boolean);
    if (!append) { L.emails = new Map(); L.members = new Map(); L.items = []; }
    for (const e of items) {
      L.emails.set(e.id, e);
      L.members.set(e.threadId, threadEmails.get(e.threadId) || [e]);
    }
    L.items = append ? L.items.concat(items.filter(e => !L.items.some(x => x.id === e.id))) : items;
    L.total = typeof q.total === 'number' ? q.total : L.items.length;
    L.position = position + q.ids.length;
    L.searchAll = all;
    L.terms = terms;
    L.error = null;
  } catch (e) {
    if (seq !== listSeq) return;
    L.error = e;
    if (e instanceof api.SessionEndedError) return;
    console.error('[list]', e);
  } finally {
    if (seq === listSeq) { L.loading = false; emit('list'); }
  }
}

export function hasMore() { return state.list.position < state.list.total; }

/** Summary of a conversation for the list. */
export function threadSummary(rep) {
  const members = (state.list.members.get(rep.threadId) || [rep]).filter(inScope);
  const list = members.length ? members : [rep];
  const unread = list.some(e => !e.keywords || !e.keywords.$seen);
  const flagged = list.some(e => e.keywords && e.keywords.$flagged);
  const draft = list.some(e => e.keywords && e.keywords.$draft);
  const attachment = list.some(e => e.hasAttachment);
  const names = [];
  const inSent = isRole(state.view.mailboxId, 'sent') || isRole(state.view.mailboxId, 'drafts');
  for (const e of list.slice().sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)))) {
    const people = inSent ? (e.to || []) : (e.from || []);
    for (const p of people) {
      const n = p.name ? p.name.split(/\s+/)[0] : (p.email || '').split('@')[0];
      const self = state.user.email && p.email && p.email.toLowerCase() === state.user.email.toLowerCase();
      const label = self && !inSent ? 'me' : n;
      if (label && !names.includes(label)) names.push(label);
    }
  }
  const labels = new Set();
  let assignee = null;
  for (const e of list) for (const k of Object.keys(e.keywords || {})) {
    if (k.startsWith('label:')) labels.add(k.slice(6));
    else if (k.startsWith('assigned:') && !assignee) assignee = k.slice(9);
  }
  return { count: list.length, unread, flagged, draft, attachment, names, members: list, inSent, labels: Array.from(labels), assignee };
}

/* ——— Labels and assignment (keywords) ——— */
export const assignedKeyword = email => 'assigned:' + String(email || '').toLowerCase();
export const labelOf = slug => state.labels.find(l => l.slug === slug) || null;

/** Puts a label on (or takes it off) messages. */
export function setLabel(ids, slug, on) { return setKeyword(ids, 'label:' + slug, on); }

/** Assigns messages of a team mailbox to a member (null = nobody). */
export async function assign(emails, email) {
  if (!emails.length) return;
  const update = {};
  for (const e of emails) {
    const patch = {};
    for (const k of Object.keys(e.keywords || {})) if (k.startsWith('assigned:')) patch['keywords/' + k] = null;
    if (email) patch['keywords/' + assignedKeyword(email)] = true;
    update[e.id] = patch;
  }
  const r = await api.call([['Email/set', { accountId: viewAccount(), update }, 's']]);
  api.checkSet(r.get('s'), 'assign the message');
  patchLocal(emails.map(e => e.id), e => {
    const kw = {};
    for (const [k, v] of Object.entries(e.keywords || {})) if (!k.startsWith('assigned:')) kw[k] = v;
    if (email) kw[assignedKeyword(email)] = true;
    e.keywords = kw;
  });
  emit('list');
}

/** Removes a deleted label from every message of the person's own mailbox. */
export async function clearLabelEverywhere(slug) {
  const acc = api.accountId();
  for (let round = 0; round < 20; round++) {
    const r = await api.call([['Email/query', { accountId: acc, filter: { hasKeyword: 'label:' + slug }, limit: 400 }, 'q']]);
    const ids = r.get('q').ids;
    if (!ids.length) break;
    const update = {};
    for (const id of ids) update[id] = { ['keywords/label:' + slug]: null };
    api.checkSet((await api.call([['Email/set', { accountId: acc, update }, 's']])).get('s'), 'remove the label');
  }
}

/** Emails of a conversation that an action applies to (in the current folder when there is one). */
export function actionEmails(threadId, { wholeThread = false } = {}) {
  const members = (state.list.members.get(threadId) || []).filter(inScope);
  const v = state.view;
  if (wholeThread || state.list.searchAll || !v.mailboxId) return members;
  const inFolder = members.filter(e => e.mailboxIds && e.mailboxIds[v.mailboxId]);
  return inFolder.length ? inFolder : members;
}

/* ——— Changes ——— */
function patchLocal(ids, fn) {
  const set = new Set(ids);
  for (const list of state.list.members.values()) for (const e of list) if (set.has(e.id)) fn(e);
  for (const e of state.list.emails.values()) if (set.has(e.id)) fn(e);
}

export async function setKeyword(ids, keyword, value) {
  if (!ids.length) return;
  const update = {};
  for (const id of ids) update[id] = { ['keywords/' + keyword]: value ? true : null };
  patchLocal(ids, e => { e.keywords = { ...(e.keywords || {}) }; if (value) e.keywords[keyword] = true; else delete e.keywords[keyword]; });
  emit('list');
  try {
    const r = await api.call([['Email/set', { accountId: viewAccount(), update }, 's']]);
    api.checkSet(r.get('s'), 'update the message');
  } catch (e) {
    patchLocal(ids, x => { x.keywords = { ...(x.keywords || {}) }; if (value) delete x.keywords[keyword]; else x.keywords[keyword] = true; });
    emit('list');
    throw e;
  }
  refreshCountsSoon();
}

/**
 * Moves emails into `toId`. With fromId, only that folder is swapped (other folders kept);
 * without it, the emails end up only in `toId`. Returns an undo function.
 */
export async function moveEmails(emails, toId, { fromId = null, extra = null } = {}) {
  if (!emails.length) return () => {};
  const acc = viewAccount(); // the undo acts on this mailbox even if the view changes meanwhile
  const update = {};
  const undo = {};
  for (const e of emails) {
    const from = fromId && e.mailboxIds && e.mailboxIds[fromId] ? fromId : null;
    if (from) {
      update[e.id] = { ['mailboxIds/' + from]: null, ['mailboxIds/' + toId]: true, ...(extra || {}) };
      undo[e.id] = { ['mailboxIds/' + from]: true };
      if (!e.mailboxIds[toId]) undo[e.id]['mailboxIds/' + toId] = null;
    } else {
      update[e.id] = { mailboxIds: { [toId]: true }, ...(extra || {}) };
      undo[e.id] = { mailboxIds: { ...(e.mailboxIds || {}) } };
    }
    if (extra) for (const k of Object.keys(extra)) {
      const kw = k.replace(/^keywords\//, '');
      undo[e.id][k] = e.keywords && e.keywords[kw] ? true : null;
    }
  }
  const r = await api.call([['Email/set', { accountId: acc, update }, 's']]);
  api.checkSet(r.get('s'), 'move the message');
  return async () => {
    const u = await api.call([['Email/set', { accountId: acc, update: undo }, 's']]);
    api.checkSet(u.get('s'), 'undo');
  };
}

/** Takes emails out of one folder, leaving their other folders alone. */
export async function removeFromMailbox(ids, mailboxId) {
  if (!ids.length) return;
  const update = {};
  for (const id of ids) update[id] = { ['mailboxIds/' + mailboxId]: null };
  const r = await api.call([['Email/set', { accountId: viewAccount(), update }, 's']]);
  api.checkSet(r.get('s'), 'remove the message from the folder');
}

export async function destroyEmails(ids) {
  if (!ids.length) return;
  const r = await api.call([['Email/set', { accountId: viewAccount(), destroy: ids }, 's']]);
  api.checkSet(r.get('s'), 'delete the message');
}

/** Marks every unread message of a folder as read (in batches). */
export async function markFolderRead(mailboxId) {
  const acc = viewAccount();
  for (let round = 0; round < 20; round++) {
    const r = await api.call([
      ['Email/query', { accountId: acc, filter: { inMailbox: mailboxId, notKeyword: '$seen' }, limit: 400 }, 'q']
    ]);
    const ids = r.get('q').ids;
    if (!ids.length) break;
    const update = {};
    for (const id of ids) update[id] = { 'keywords/$seen': true };
    const s = await api.call([['Email/set', { accountId: acc, update }, 's']]);
    api.checkSet(s.get('s'), 'mark messages as read');
  }
}

/* ——— Counts, identities, quota ——— */
let countsTimer = null;
export function refreshCountsSoon() {
  clearTimeout(countsTimer);
  countsTimer = setTimeout(() => loadMailboxes().catch(() => {}), 400);
}

export async function loadIdentities() {
  const r = await api.call([['Identity/get', { accountId: api.accountId() }, 'i']]);
  state.identities = r.get('i').list || [];
  emit('identities');
}

export async function loadQuota() {
  if (!api.hasCapability(api.CAP.quota)) return null;
  try {
    const r = await api.call([['Quota/get', { accountId: api.accountId(), ids: null }, 'q']], { using: [api.CAP.core, api.CAP.quota] });
    const list = (r.get('q').list || []).filter(q => q.resourceType === 'octets');
    return list.sort((a, b) => (b.hardLimit || 0) - (a.hardLimit || 0))[0] || null;
  } catch (e) { return null; }
}

/** Full messages of a conversation, oldest first (for the reader). */
export async function loadThread(threadId) {
  const acc = viewAccount();
  const r = await api.call([
    ['Thread/get', { accountId: acc, ids: [threadId] }, 't'],
    ['Email/get', {
      accountId: acc,
      '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' },
      properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'bcc', 'replyTo', 'sender', 'subject', 'sentAt', 'receivedAt',
        'messageId', 'inReplyTo', 'references', 'blobId', 'preview', 'hasAttachment', 'attachments', 'htmlBody', 'textBody', 'bodyValues', 'size'],
      fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1500000,
      bodyProperties: ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'location']
    }, 'g']
  ]);
  const emails = (r.get('g').list || []).sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  // Keep the list's copy in step (flags may have changed elsewhere).
  const members = state.list.members.get(threadId);
  if (members) {
    const byId = new Map(emails.map(e => [e.id, e]));
    for (const m of members) { const f = byId.get(m.id); if (f) { m.keywords = f.keywords; m.mailboxIds = f.mailboxIds; } }
  }
  return emails;
}

/* ——— Address book for autocomplete ——— */
let addressBook = null;
export async function loadAddressBook() {
  if (addressBook) return addressBook;
  const seen = new Map();
  const add = (a, weight) => {
    if (!a || !a.email) return;
    const key = a.email.toLowerCase();
    const cur = seen.get(key) || { email: a.email, name: '', score: 0 };
    if (a.name && !cur.name) cur.name = a.name;
    cur.score += weight;
    seen.set(key, cur);
  };
  const acc = api.accountId();
  const own = folderSet(acc).roles;
  try {
    const calls = [];
    if (own.sent) {
      calls.push(['Email/query', { accountId: acc, filter: { inMailbox: own.sent }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 300 }, 'sq']);
      calls.push(['Email/get', { accountId: acc, '#ids': { resultOf: 'sq', name: 'Email/query', path: '/ids' }, properties: ['to', 'cc', 'bcc'] }, 'sg']);
    }
    calls.push(['Email/query', { accountId: acc, filter: own.inbox ? { inMailbox: own.inbox } : {}, sort: [{ property: 'receivedAt', isAscending: false }], limit: 300 }, 'iq']);
    calls.push(['Email/get', { accountId: acc, '#ids': { resultOf: 'iq', name: 'Email/query', path: '/ids' }, properties: ['from', 'replyTo'] }, 'ig']);
    const r = await api.call(calls, { allowErrors: true });
    const sg = r.get('sg');
    if (sg && !sg.error) for (const e of sg.list) for (const a of [...(e.to || []), ...(e.cc || []), ...(e.bcc || [])]) add(a, 3);
    const ig = r.get('ig');
    if (ig && !ig.error) for (const e of ig.list) for (const a of [...(e.replyTo || e.from || [])]) add(a, 1);
  } catch (e) { /* suggestions are optional */ }
  if (api.hasCapability(api.CAP.contacts)) {
    try {
      const r = await api.call([['ContactCard/get', { accountId: acc, ids: null, properties: ['name', 'emails'] }, 'c']],
        { using: [api.CAP.core, api.CAP.contacts], allowErrors: true });
      const c = r.get('c');
      if (c && !c.error) for (const card of c.list || []) {
        const nm = card.name && (card.name.full || (card.name.components || []).map(x => x.value).join(' ')) || '';
        for (const em of Object.values(card.emails || {})) add({ email: em.address, name: nm }, 5);
      }
    } catch (e) { /* no contacts */ }
  }
  const me = state.user.email.toLowerCase();
  addressBook = Array.from(seen.values()).filter(a => a.email.toLowerCase() !== me).sort((a, b) => b.score - a.score);
  return addressBook;
}
export function forgetAddressBook() { addressBook = null; }

/** Copies files from a team mailbox into the person's own (to forward its attachments). */
export async function copyBlobs(fromAccountId, blobIds) {
  if (!blobIds.length || fromAccountId === api.accountId()) return new Map(blobIds.map(b => [b, b]));
  const r = await api.call([['Blob/copy', { fromAccountId, accountId: api.accountId(), blobIds }, 'c']], { using: [api.CAP.core] });
  const res = r.get('c');
  return new Map(Object.entries(res.copied || {}));
}
