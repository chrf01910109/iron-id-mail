// Conversation list: search box, quick filters, paging, selection, stars and drag to folders.

import * as mail from './mail.js';
import { h, $, $$, icon, avatar, shortDate, toast, debounce } from './util.js';
import { t, locale } from './i18n.js';

let onOpenThread = () => {};
const listEl = () => $('#emailList');

export function init({ openThread }) {
  onOpenThread = openThread;
  mail.on('list', render);
  mail.on('list-loading', () => {
    if (!mail.state.list.items.length) listEl().replaceChildren(h('div', { class: 'loading-text' }, t('Loading…')));
  });
  mail.on('mailboxes', renderHeader);

  // Search: Enter searches; clearing the box returns to the folder.
  const input = $('#searchInput');
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(input.value); input.blur(); });
  input.addEventListener('search', () => { if (!input.value) runSearch(''); });
  input.addEventListener('input', debounce(() => { if (!input.value && mail.state.view.search) runSearch(''); }, 300));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { input.value = ''; runSearch(''); input.blur(); } });
  $('#searchHelpBtn').addEventListener('click', () => $('#searchHelp').classList.toggle('hidden'));

  for (const tab of $$('.filter-tab')) {
    tab.addEventListener('click', () => setFilter(tab.dataset.filter));
  }
  $('#btnMarkAllRead').addEventListener('click', async () => {
    const id = mail.state.view.mailboxId;
    if (!id) return;
    try { await mail.markFolderRead(id); toast(t('All messages marked as read')); await Promise.all([mail.loadMailboxes(), mail.loadList()]); }
    catch (e) { toast(e.message, false); }
  });

  // Load the next page when scrolled near the end.
  listEl().addEventListener('scroll', () => {
    const el = listEl();
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 300 && mail.hasMore() && !mail.state.list.loading) mail.loadList({ append: true });
  });
  // Keyboard inside the list.
  listEl().addEventListener('keydown', e => {
    if (e.key === 'Enter' && mail.state.selected) { e.preventDefault(); onOpenThread(mail.state.selected, { focusReader: true }); }
  });
}

export function runSearch(q) {
  $('#searchInput').value = q;
  mail.state.view.search = q.trim();
  mail.state.selected = null;
  $('#searchHelp').classList.add('hidden');
  listEl().scrollTop = 0;
  mail.loadList();
  renderHeader();
}

export function setFilter(f) {
  mail.state.view.filter = f;
  syncFilterTabs();
  listEl().scrollTop = 0;
  mail.loadList();
}

export function syncFilterTabs() {
  const f = mail.state.view.filter;
  for (const t of $$('.filter-tab')) t.classList.toggle('active', t.dataset.filter === f);
}

export function renderHeader() {
  const v = mail.state.view;
  const mb = v.label ? null : mail.currentMailbox();
  const label = v.label ? mail.labelOf(v.label) : null;
  const team = mail.isTeamView() ? mail.teamFor(mail.viewAccount()) : null;
  const searching = !!v.search;
  const p = searching ? mail.parseSearch(v.search) : null;
  const place = label ? label.name : (mb ? mail.mailboxName(mb) : t('Mail'));
  $('#activeFolderName').textContent = searching ? t('Search results') : (team ? (team.name || team.email) + ' · ' : '') + place;
  const badge = $('#activeFolderBadge');
  badge.classList.toggle('hidden', !!label);
  if (!searching && mb) badge.textContent = String(mb.totalThreads || mb.totalEmails || 0);
  $('#btnMarkAllRead').classList.toggle('hidden', searching || !mb || !(mb.unreadEmails > 0));
  $('#filterMine').classList.toggle('hidden', !team);
  const sb = $('#searchBadge');
  sb.classList.toggle('hidden', !searching);
  sb.textContent = searching ? (p.all ? t('in all folders') : t('in {folder}', { folder: place })) : '';
  const unread = mb ? (mb.unreadThreads || mb.unreadEmails || 0) : 0;
  $('#unreadFilterCount').textContent = unread ? `(${unread})` : '';
}

/** Wraps search terms found in text with <mark>. Returns nodes. */
function highlight(text, terms) {
  const t = String(text || '');
  const words = terms.flatMap(x => String(x).split(/\s+/)).map(w => w.replace(/^["']|["']$/g, '')).filter(w => w.length >= 2);
  if (!words.length) return [t];
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const nt = norm(t);
  if (nt.length !== t.length) return [t]; // can't map positions safely
  const marks = [];
  for (const w of words) {
    const nw = norm(w);
    let i = nt.indexOf(nw);
    while (i !== -1 && marks.length < 20) { marks.push([i, i + nw.length]); i = nt.indexOf(nw, i + nw.length); }
  }
  if (!marks.length) return [t];
  marks.sort((a, b) => a[0] - b[0]);
  const out = []; let pos = 0;
  for (const [s, e] of marks) {
    if (s < pos) continue;
    if (s > pos) out.push(t.slice(pos, s));
    out.push(h('mark', { class: 'hl' }, t.slice(s, e)));
    pos = e;
  }
  if (pos < t.length) out.push(t.slice(pos));
  return out;
}

function itemFor(rep) {
  const s = mail.threadSummary(rep);
  const selected = mail.state.selected === rep.threadId;
  const terms = mail.state.list.terms;
  const lead = s.inSent ? (rep.to && rep.to[0]) : (rep.from && rep.from[0]);
  const names = s.names.slice(0, 3).join(', ') + (s.names.length > 3 ? '…' : '');
  const who = s.names.length ? (s.inSent ? t('To: {names}', { names }) : names) : (s.inSent ? t('(no recipient)') : t('Unknown'));
  const star = h('button', {
    type: 'button', class: 'ei-star' + (s.flagged ? ' on' : ''), title: s.flagged ? t('Remove star') : t('Star'),
    'aria-label': s.flagged ? t('Remove star') : t('Star'), 'aria-pressed': String(s.flagged)
  }, icon('star', 14, 1.8));
  star.addEventListener('click', async e => {
    e.stopPropagation();
    const ids = s.flagged ? s.members.filter(x => x.keywords && x.keywords.$flagged).map(x => x.id) : [s.members[s.members.length - 1].id];
    try { await mail.setKeyword(ids, '$flagged', !s.flagged); } catch (err) { toast(err.message, false); }
  });
  const item = h('div', {
    class: 'email-item' + (selected ? ' selected' : '') + (s.unread ? ' unread' : ''),
    role: 'option', 'aria-selected': String(selected), tabindex: selected ? '0' : '-1',
    draggable: 'true', dataset: { thread: rep.threadId, id: rep.id }
  },
    s.unread ? h('div', { class: 'ei-unread-dot', 'aria-label': t('Unread') }) : null,
    avatar(lead && lead.name, lead && lead.email),
    h('div', { class: 'ei-body' },
      h('div', { class: 'ei-top' },
        h('span', { class: 'ei-sender' }, ...highlight(who, terms),
          s.count > 1 ? h('span', { class: 'ei-count' }, String(s.count)) : null,
          s.draft ? h('span', { class: 'ei-draft' }, ' ' + t('Draft')) : null),
        h('span', { class: 'ei-meta' },
          s.attachment ? h('span', { class: 'ei-icon', title: t('Has attachments') }, icon('clip', 13)) : null,
          h('span', { class: 'ei-time', title: new Date(rep.receivedAt).toLocaleString(locale) }, shortDate(rep.receivedAt)))),
      h('div', { class: 'ei-subject', dir: 'auto' }, ...highlight(rep.subject || t('(no subject)'), terms)),
      (s.labels.length || s.assignee) ? h('div', { class: 'ei-tags' },
        ...s.labels.map(mail.labelOf).filter(Boolean).map(l => h('span', { class: 'label-chip c-' + l.color }, l.name)),
        s.assignee ? h('span', { class: 'assign-chip', title: t('Assigned to {name}', { name: s.assignee }) }, icon('user', 11), s.assignee === mail.state.user.email.toLowerCase() ? t('me') : s.assignee.split('@')[0]) : null) : null,
      h('div', { class: 'ei-top' },
        h('div', { class: 'ei-preview', dir: 'auto' }, ...highlight((rep.preview || '').slice(0, 160), terms)),
        star)));
  item.addEventListener('click', () => onOpenThread(rep.threadId));
  item.addEventListener('dragstart', e => {
    e.dataTransfer.setData('application/x-ironid-thread', rep.threadId);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('dragging'));
  return item;
}

export function render() {
  const L = mail.state.list;
  const el = listEl();
  renderHeader();
  if (L.error && !L.items.length) {
    el.replaceChildren(h('div', { class: 'loading-text list-error' }, t('Could not load messages: {error}', { error: L.error.message })));
    return;
  }
  if (!L.items.length) {
    const v = mail.state.view;
    const msg = v.search ? t('No messages match your search.') : v.filter === 'unread' ? t('No unread messages.') : v.filter === 'starred' ? t('No starred messages.')
      : v.filter === 'mine' ? t('Nothing is assigned to you here.') : v.label ? t('No messages with this label.') : t('No messages in this folder.');
    el.replaceChildren(h('div', { class: 'loading-text' }, L.loading ? t('Loading…') : msg));
    return;
  }
  const scroll = el.scrollTop;
  const nodes = L.items.map(itemFor);
  if (mail.hasMore()) {
    const more = h('div', { class: 'list-more' }, L.loading ? h('span', { class: 'muted small' }, t('Loading…')) : h('button', { type: 'button', class: 'lh-link' }, t('Show more ({n} left)', { n: L.total - L.items.length })));
    const b = more.querySelector('button');
    if (b) b.addEventListener('click', () => mail.loadList({ append: true }));
    nodes.push(more);
  }
  el.replaceChildren(...nodes);
  el.scrollTop = scroll;
}

/** Selects the next/previous conversation (keyboard j/k). Returns the new threadId or null. */
export function step(dir) {
  const items = mail.state.list.items;
  if (!items.length) return null;
  let i = items.findIndex(e => e.threadId === mail.state.selected);
  i = i === -1 ? 0 : Math.max(0, Math.min(items.length - 1, i + dir));
  if (i === items.length - 1 && dir > 0 && mail.hasMore()) mail.loadList({ append: true });
  return items[i].threadId;
}

export function markSelected(threadId) {
  for (const el of $$('.email-item', listEl())) {
    const on = el.dataset.thread === threadId;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', String(on));
    el.tabIndex = on ? 0 : -1;
    if (on) {
      // Scroll only the list (scrollIntoView would also move the page layout on phones).
      const box = listEl();
      const top = el.offsetTop - box.offsetTop, bottom = top + el.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }
  }
}

export function focusSelected() {
  const el = $('.email-item.selected', listEl()) || $('.email-item', listEl());
  if (el) el.focus();
}
