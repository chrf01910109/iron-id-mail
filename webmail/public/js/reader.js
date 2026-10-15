// Reading pane: a conversation as message cards, safe bodies, attachments and actions.

import * as api from './api.js';
import * as mail from './mail.js';
import * as labels from './labels.js';
import { renderHtmlEmail, renderPlainText, htmlToText, normCid } from './safeHtml.js';
import { h, $, icon, avatar, longDate, shortDate, formatSize, displayName, formatAddressList, toast, dialog, openMenu, savePrefs } from './util.js';

let hooks = {};
let current = null;        // { threadId, emails, shown }
let objectUrls = [];       // inline pictures to release
const allowRemoteFor = new Set(); // email ids whose pictures were allowed this session

export function init(h) { hooks = h; }
export const currentThread = () => current;

function releaseUrls() { for (const u of objectUrls) URL.revokeObjectURL(u); objectUrls = []; }

export function clear(text = 'Select a message to read it') {
  releaseUrls();
  current = null;
  $('#readerPane').replaceChildren(h('div', { class: 'reader-empty' }, h('div', {},
    h('div', { class: 'reader-empty-icon', html: '<svg width="48" height="48" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>' }),
    h('p', {}, text))));
}

/** Messages of the conversation that belong in this view (Trash/Junk only when looking there). */
function visible(emails) {
  const shown = emails.filter(mail.inScope);
  return shown.length ? shown : emails;
}

let openSeq = 0;
export async function open(threadId) {
  const seq = ++openSeq;
  const pane = $('#readerPane');
  if (!current || current.threadId !== threadId) {
    // Nothing acts on the previous conversation while the next one loads.
    current = null;
    releaseUrls();
    pane.replaceChildren(h('div', { class: 'loading-text' }, 'Opening…'));
  }
  let emails;
  try { emails = await mail.loadThread(threadId); }
  catch (e) {
    if (seq !== openSeq) return;
    if (e instanceof api.SessionEndedError) return;
    pane.replaceChildren(h('div', { class: 'loading-text list-error' }, 'Could not open this conversation: ' + e.message));
    return;
  }
  if (seq !== openSeq) return;
  if (!emails.length) { clear('This conversation no longer exists.'); return; }
  releaseUrls();
  const shown = visible(emails);
  current = { threadId, emails, shown };
  render();
  // Mark as read.
  if (mail.state.prefs.autoSeen) {
    const unread = shown.filter(e => !e.keywords || !e.keywords.$seen).map(e => e.id);
    if (unread.length) {
      for (const e of shown) if (unread.includes(e.id)) e.keywords = { ...(e.keywords || {}), $seen: true };
      mail.setKeyword(unread, '$seen', true).catch(err => toast(err.message, false));
    }
  }
}

/** Re-reads the open conversation (after a change elsewhere) without losing scroll. */
export async function refresh() {
  if (!current) return;
  const pane = $('#readerPane');
  const top = pane.scrollTop;
  const threadId = current.threadId;
  try {
    const emails = await mail.loadThread(threadId);
    if (!current || current.threadId !== threadId) return;
    if (!emails.length) { clear('This conversation was moved or deleted.'); return; }
    const sig = es => es.map(e => e.id + JSON.stringify(e.keywords) + JSON.stringify(e.mailboxIds)).join('|');
    if (sig(emails) === sig(current.emails)) return;
    const expanded = new Set(Array.from(pane.querySelectorAll('.msg-card.expanded')).map(c => c.dataset.id));
    current = { threadId, emails, shown: visible(emails) };
    render(expanded);
    pane.scrollTop = top;
  } catch (e) { /* keep what is shown */ }
}

function latest(list, { skipDrafts = true } = {}) {
  const l = skipDrafts ? list.filter(e => !(e.keywords && e.keywords.$draft)) : list;
  return (l.length ? l : list)[(l.length ? l : list).length - 1];
}

/** The conversation's subject: the first message's, without "Re:"/"Fwd:" prefixes. */
function threadSubject(list) {
  const first = list.find(e => e.subject) || list[0];
  const subj = (first && first.subject) || '';
  return subj.replace(/^\s*((re|fwd?|tr|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, '') || '(no subject)';
}

function toolbarButton(label, iconName, title, onClick, extra = {}) {
  const b = h('button', { type: 'button', class: 'tb-btn' + (extra.cls ? ' ' + extra.cls : ''), title, 'aria-label': label, 'aria-pressed': extra.pressed }, icon(iconName), h('span', {}, label));
  b.addEventListener('click', onClick);
  return b;
}

function render(expandedIds = null) {
  const { shown } = current;
  const v = mail.state.view;
  const inTrash = shown.every(e => Object.keys(e.mailboxIds).some(id => mail.isRole(id, 'trash')));
  const inJunk = shown.every(e => Object.keys(e.mailboxIds).some(id => mail.isRole(id, 'junk')));
  const inArchive = !!v.mailboxId && mail.isRole(v.mailboxId, 'archive');
  const anyUnread = shown.some(e => !e.keywords || !e.keywords.$seen);
  const flagged = shown.some(e => e.keywords && e.keywords.$flagged);
  const last = latest(shown);

  const tb = h('div', { class: 'ev-toolbar' },
    toolbarButton('Back', 'back', 'Back to the list (Esc)', () => hooks.back(), { cls: 'back-btn' }),
    h('div', { class: 'tb-group' },
      toolbarButton('Reply', 'reply', 'Reply', () => hooks.reply('reply', last)),
      toolbarButton('Reply all', 'replyAll', 'Reply all', () => hooks.reply('replyAll', last)),
      toolbarButton('Forward', 'forward', 'Forward', () => hooks.reply('forward', last))),
    h('div', { class: 'tb-divider' }),
    h('div', { class: 'tb-group icon-only' },
      inTrash ? toolbarButton('Restore', 'restore', 'Move back to the Inbox', () => hooks.action('restore'))
        : (inArchive ? null : toolbarButton('Archive', 'archive', 'Archive (e)', () => hooks.action('archive'))),
      toolbarButton('Move', 'move', 'Move to folder (v)', e => hooks.action('move', e.currentTarget)),
      inJunk ? toolbarButton('Not spam', 'notSpam', 'Not spam: move to the Inbox', () => hooks.action('notSpam'))
        : (inTrash ? null : toolbarButton('Spam', 'junk', 'Report spam', () => hooks.action('spam'))),
      toolbarButton(inTrash ? 'Delete forever' : 'Delete', 'trash', inTrash ? 'Delete permanently' : 'Delete (#)', () => hooks.action('delete'), { cls: 'danger' })),
    h('div', { class: 'tb-divider' }),
    h('div', { class: 'tb-group icon-only' },
      toolbarButton(anyUnread ? 'Mark read' : 'Mark unread', 'mailOpen', anyUnread ? 'Mark read (Shift+I)' : 'Mark unread (Shift+U)', () => hooks.action(anyUnread ? 'read' : 'unread')),
      toolbarButton(flagged ? 'Starred' : 'Star', 'star', flagged ? 'Remove star (s)' : 'Star (s)', () => hooks.action('star'), { pressed: String(flagged) }),
      mail.isTeamView() ? null : toolbarButton('Label', 'tag', 'Label (l)', e => openLabelMenu(e.currentTarget)),
      mail.isTeamView() ? toolbarButton('Assign', 'user', 'Assign to a team member', e => openAssignMenu(e.currentTarget)) : null,
      toolbarButton('Print', 'print', 'Print', () => window.print())));

  const folders = new Set();
  for (const e of shown) for (const id of Object.keys(e.mailboxIds)) folders.add(id);
  const sum = mail.threadSummary(shown[shown.length - 1]);
  const lbls = Array.from(new Set(shown.flatMap(e => Object.keys(e.keywords || {}).filter(k => k.startsWith('label:')).map(k => k.slice(6)))));
  const assignee = (shown.flatMap(e => Object.keys(e.keywords || {})).find(k => k.startsWith('assigned:')) || '').slice(9) || (sum && sum.assignee);
  const head = h('div', {},
    h('div', { class: 'thread-subject', dir: 'auto' }, threadSubject(shown)),
    h('div', { class: 'thread-sub' },
      h('span', {}, shown.length + (shown.length === 1 ? ' message' : ' messages')),
      mail.isTeamView() ? h('span', { class: 'folder-chip team-chip' }, mail.teamFor(mail.viewAccount()).email) : null,
      ...Array.from(folders).map(id => mail.state.byId.get(id)).filter(Boolean).map(mb => h('span', { class: 'folder-chip' }, mail.mailboxName(mb))),
      ...lbls.map(mail.labelOf).filter(Boolean).map(l => h('span', { class: 'label-chip c-' + l.color }, l.name)),
      assignee ? h('span', { class: 'assign-chip', title: 'Assigned to ' + assignee }, icon('user', 12), memberName(assignee)) : null));

  const cards = shown.map((e, i) => {
    const expand = expandedIds ? expandedIds.has(e.id) : (i === shown.length - 1 || !e.keywords || !e.keywords.$seen || shown.length <= 2);
    return card(e, expand || (expandedIds && i === shown.length - 1 && !expandedIds.size));
  });
  const ev = h('div', { class: 'ev' }, tb, head, ...cards);
  $('#readerPane').replaceChildren(ev);
  $('#readerPane').scrollTop = 0;
}

/** Display name of a team member (from the team list), or the address. */
function memberName(email) {
  if (email === mail.state.user.email.toLowerCase()) return 'me';
  const t = mail.teamFor(mail.viewAccount());
  const m = t && t.members.find(x => x.email === email);
  return (m && m.name) || email;
}

export function openLabelMenu(anchor) {
  if (!current || mail.isTeamView()) return; // labels belong to the person's own mailbox
  openMenu(anchor || $('#readerPane .ev-toolbar') || $('#readerPane'), labels.applyMenu(current.shown, () => { mail.emit('list'); render(currentExpanded()); }));
}

function openAssignMenu(anchor) {
  if (!current) return;
  const team = mail.teamFor(mail.viewAccount());
  const shown = current.shown;
  const now = (shown.flatMap(e => Object.keys(e.keywords || {})).find(k => k.startsWith('assigned:')) || '').slice(9);
  const set = async email => {
    try {
      await mail.assign(shown, email);
      toast(email ? 'Assigned to ' + memberName(email) : 'Unassigned');
      render(currentExpanded());
    } catch (e) { toast(e.message, false); }
  };
  const me = mail.state.user.email.toLowerCase();
  const members = (team.members || []).slice().sort((a, b) => (a.email === me ? -1 : b.email === me ? 1 : 0));
  openMenu(anchor, [
    { title: 'Assign to' },
    ...members.map(m => ({ label: m.email === me ? 'Me' : (m.name ? `${m.name} (${m.email})` : m.email), icon: 'user', checked: now === m.email, run: () => set(m.email) })),
    ...(members.length ? [] : [{ title: 'No members found' }]),
    ...(now ? [{ label: 'Unassign', icon: 'restore', run: () => set(null) }] : [])
  ]);
}

function currentExpanded() {
  return new Set(Array.from($('#readerPane').querySelectorAll('.msg-card.expanded')).map(c => c.dataset.id));
}

function card(e, expanded) {
  const from = (e.from && e.from[0]) || { name: '', email: '' };
  const isDraft = e.keywords && e.keywords.$draft;
  const to = [e.to && e.to.length ? 'to ' + formatAddressList(e.to) : '', e.cc && e.cc.length ? 'cc ' + formatAddressList(e.cc) : '', e.bcc && e.bcc.length ? 'bcc ' + formatAddressList(e.bcc) : ''].filter(Boolean).join(' · ');
  const body = h('div', { class: 'msg-body' });
  const actions = h('div', { class: 'msg-actions' });
  const el = h('article', { class: 'msg-card' + (expanded ? ' expanded' : ''), dataset: { id: e.id } },
    h('div', { class: 'msg-head', role: 'button', tabindex: '0', 'aria-expanded': String(expanded) },
      avatar(from.name, from.email, 'ev-avatar'),
      h('div', { class: 'msg-head-info' },
        h('div', { class: 'msg-from' }, h('span', { dir: 'auto' }, displayName(from) || '(unknown sender)'), from.name ? h('span', { class: 'addr' }, '<' + from.email + '>') : null,
          isDraft ? h('span', { class: 'ei-draft' }, 'Draft') : null),
        h('div', { class: 'msg-to', title: to }, to),
        h('div', { class: 'msg-snippet', dir: 'auto' }, e.preview || '')),
      h('div', { class: 'msg-date', title: longDate(e.receivedAt) }, expanded ? longDate(e.receivedAt) : shortDate(e.receivedAt))),
    body, actions);
  let filled = false;
  const fill = () => { if (!filled) { filled = true; fillBody(e, body); fillActions(e, actions); } };
  if (expanded) fill();
  const head = el.querySelector('.msg-head');
  const toggle = () => {
    const on = el.classList.toggle('expanded');
    head.setAttribute('aria-expanded', String(on));
    el.querySelector('.msg-date').textContent = on ? longDate(e.receivedAt) : shortDate(e.receivedAt);
    if (on) fill();
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  return el;
}

function fillActions(e, actions) {
  const isDraft = e.keywords && e.keywords.$draft;
  const mk = (label, ic, fn) => { const b = h('button', { type: 'button', class: 'act-btn' }, icon(ic), label); b.addEventListener('click', fn); return b; };
  if (isDraft) {
    actions.append(mk('Edit draft', 'drafts', () => hooks.editDraft(e)));
    return;
  }
  actions.append(
    mk('Reply', 'reply', () => hooks.reply('reply', e)),
    mk('Reply all', 'replyAll', () => hooks.reply('replyAll', e)),
    mk('Forward', 'forward', () => hooks.reply('forward', e)));
  const more = h('button', { type: 'button', class: 'act-btn', title: 'More', 'aria-label': 'More actions' }, icon('dots'));
  more.addEventListener('click', () => openMenu(more, [
    // nosemgrep: javascript-url-or-unvalidated-href -- always a same-site /proxy/jmap/download/... path with encoded parts
    { label: 'Download original (.eml)', icon: 'download', run: () => { window.location.href = api.downloadUrl(e.blobId || e.id, safeFileName(e.subject) + '.eml', 'message/rfc822'); } },
    { label: (e.keywords && e.keywords.$seen) ? 'Mark this message unread' : 'Mark this message read', icon: 'mailOpen',
      run: () => mail.setKeyword([e.id], '$seen', !(e.keywords && e.keywords.$seen)).then(() => refresh()).catch(err => toast(err.message, false)) }
  ]));
  actions.append(more);
}

function safeFileName(s) { return (String(s || 'message').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 80)) || 'message'; }

function bodyParts(e) {
  const values = e.bodyValues || {};
  const html = (e.htmlBody || []).filter(p => /^text\/html/i.test(p.type) && values[p.partId]);
  if (html.length) {
    // Join every part of the HTML version (some mailers split it around pictures).
    const parts = (e.htmlBody || []).map(p => {
      const v = values[p.partId];
      if (!v) return '';
      if (/^text\/html/i.test(p.type)) return v.value;
      if (/^text\//i.test(p.type)) return '<pre>' + v.value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>';
      return '';
    });
    return { kind: 'html', value: parts.join('\n'), truncated: html.some(p => values[p.partId].isTruncated) };
  }
  const text = (e.textBody || []).filter(p => values[p.partId]);
  return { kind: 'text', value: text.map(p => values[p.partId].value).join('\n'), truncated: text.some(p => values[p.partId].isTruncated) };
}

/** Plain text of a message, for quoting in replies and forwards. */
export function messageText(e) {
  const values = e.bodyValues || {};
  const text = (e.textBody || []).filter(p => /^text\/plain/i.test(p.type) && values[p.partId]);
  if (text.length) return text.map(p => values[p.partId].value).join('\n');
  const b = bodyParts(e);
  return b.kind === 'html' ? htmlToText(b.value) : b.value;
}

function attachmentList(e) {
  return (e.attachments || []).filter(a => !(a.disposition === 'inline' && a.cid && /^image\//i.test(a.type || '')) || !(e.htmlBody || []).length);
}

async function fillBody(e, body) {
  const b = bodyParts(e);
  const notices = h('div');
  const content = h('div');
  body.append(notices, content);
  const atts = attachmentList(e);

  if (b.truncated) notices.append(h('div', { class: 'notice info' }, 'This message is very long; only the beginning is shown. Use “Download original” to see all of it.'));
  const inJunk = Object.keys(e.mailboxIds || {}).some(id => mail.isRole(id, 'junk'));
  if (inJunk) notices.append(h('div', { class: 'notice danger' }, 'This message is in Junk. Be careful with its links and attachments, and never send passwords.'));

  if (b.kind === 'html') {
    // Pictures attached to the message (cid:) are loaded as local copies.
    const cidMap = new Map();
    const cids = (e.attachments || []).filter(a => a.cid && /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.type || '')).slice(0, 30);
    await Promise.all(cids.map(async a => {
      try { const u = await api.fetchBlobUrl(a.blobId, a.type); objectUrls.push(u); cidMap.set(normCid(a.cid), u); } catch (err) { /* skip picture */ }
    }));
    const senderEmail = ((e.from && e.from[0] && e.from[0].email) || '').toLowerCase();
    const prefs = mail.state.prefs;
    const allow = !inJunk && (prefs.remoteImages === 'always' || allowRemoteFor.has(e.id) || (senderEmail && prefs.trustedSenders.includes(senderEmail)));
    const { remote } = renderHtmlEmail(content, b.value, { cidMap, allowRemote: allow });
    if (remote > 0 && !allow) {
      const show = h('button', { type: 'button', class: 'lh-link' }, 'Show pictures');
      const always = senderEmail && !inJunk ? h('button', { type: 'button', class: 'lh-link' }, 'Always from ' + senderEmail) : null;
      const n = h('div', { class: 'notice' }, 'Pictures from the internet are hidden to protect your privacy.', show, always);
      show.addEventListener('click', () => { allowRemoteFor.add(e.id); n.remove(); renderHtmlEmail(content, b.value, { cidMap, allowRemote: true }); });
      if (always) always.addEventListener('click', () => {
        if (!prefs.trustedSenders.includes(senderEmail)) prefs.trustedSenders.push(senderEmail);
        savePrefs(prefs);
        allowRemoteFor.add(e.id); n.remove();
        renderHtmlEmail(content, b.value, { cidMap, allowRemote: true });
      });
      notices.append(n);
    }
  } else {
    renderPlainText(content, b.value || e.preview || '');
  }

  if (atts.length) {
    const thumbs = h('div', { class: 'att-thumbs' });
    const list = h('div', { class: 'att-list' }, ...atts.map(a => {
      const name = a.name || (a.type === 'message/rfc822' ? 'message.eml' : 'attachment');
      return h('a', { class: 'att', href: api.downloadUrl(a.blobId, name, a.type), download: name, title: `${name} (${a.type || 'file'})`, rel: 'noopener' },
        icon('clip', 14), h('span', { class: 'att-name', dir: 'auto' }, name), h('span', { class: 'att-size' }, formatSize(a.size)));
    }));
    for (const a of atts.filter(x => /^image\/(png|jpe?g|gif|webp)$/i.test(x.type || '') && x.size < 15e6).slice(0, 8)) {
      thumbs.append(h('a', { href: api.downloadUrl(a.blobId, a.name || 'image', a.type, { inline: true }), target: '_blank', rel: 'noopener noreferrer', title: a.name || 'image' },
        h('img', { src: api.downloadUrl(a.blobId, a.name || 'image', a.type, { inline: true }), alt: a.name || 'image', loading: 'lazy' })));
    }
    body.append(h('div', { class: 'muted small', style: { marginTop: '14px' } }, `${atts.length} attachment${atts.length > 1 ? 's' : ''}`));
    if (thumbs.childNodes.length) body.append(thumbs);
    body.append(list);
  }
}
