// Folder tree, team mailboxes, labels, unread counts, folder management and the storage meter.

import * as api from './api.js';
import * as mail from './mail.js';
import * as labels from './labels.js';
import { h, $, icon, toast, dialog, openMenu, formatSize } from './util.js';
import { t } from './i18n.js';

const ROLE_ICON = { inbox: 'inbox', sent: 'sent', drafts: 'drafts', archive: 'archive', trash: 'trash', junk: 'junk' };
let onOpenFolder = () => {};
let onDropThread = () => {};
let onOpenLabel = () => {};

export function init({ openFolder, dropThread, openLabel }) {
  onOpenFolder = openFolder;
  onDropThread = dropThread;
  onOpenLabel = openLabel;
  mail.on('mailboxes', render);
  mail.on('labels', renderLabels);
  $('#btnNewFolder').addEventListener('click', () => newFolder(null, api.accountId()));
  $('#btnNewLabel').addEventListener('click', async () => {
    const l = await labels.promptNew();
    if (l) onOpenLabel(l.slug);
  });
}

function validName(v) {
  if (!v) return t('Please enter a name.');
  if (v.length > 200) return t('That name is too long.');
  if (/[/\\]/.test(v)) return t('Folder names cannot contain / or \\.');
  return null;
}

async function newFolder(parentId, accountId) {
  const name = await dialog({ title: parentId ? t('New sub-folder') : t('New folder'), text: t('Folder name'), input: '', okLabel: t('Create'), validate: validName });
  if (!name) return;
  try {
    const id = await mail.createMailbox(name, parentId, accountId);
    toast(t('Folder "{name}" created', { name }));
    onOpenFolder(id, accountId);
  } catch (e) { toast(e.message, false); }
}

async function renameFolder(mb, accountId) {
  const name = await dialog({ title: t('Rename folder'), text: t('New name'), input: mb.name, okLabel: t('Rename'), validate: validName });
  if (!name || name === mb.name) return;
  try { await mail.renameMailbox(mb.id, name, accountId); toast(t('Folder renamed')); } catch (e) { toast(e.message, false); }
}

async function deleteFolder(mb, accountId) {
  const ok = await dialog({ title: t('Delete folder'), text: t('Delete the folder "{name}"? It must be empty.', { name: mb.name }), okLabel: t('Delete'), danger: true });
  if (!ok) return;
  try {
    const wasOpen = mail.state.view.mailboxId === mb.id && mail.viewAccount() === accountId;
    await mail.deleteMailbox(mb.id, accountId);
    toast(t('Folder deleted'));
    if (wasOpen) onOpenFolder(mail.state.view.mailboxId, accountId);
  } catch (e) { toast(e.message, false); }
}

function folderRows(accountId) {
  const set = mail.folderSet(accountId);
  const viewing = mail.viewAccount() === accountId && !mail.state.view.label;
  return set.mailboxes.map(mb => {
    const active = viewing && mb.id === mail.state.view.mailboxId && !mail.state.list.searchAll;
    const unread = mb.unreadThreads || mb.unreadEmails || 0;
    const showTotal = mb.role === 'drafts' ? (mb.totalEmails || 0) : 0;
    const countText = unread > 0 ? String(unread) : (showTotal ? String(showTotal) : '');
    const btn = h('button', {
      type: 'button', class: 'sb-btn' + (active ? ' active' : ''), 'aria-current': active ? 'page' : null,
      dataset: { id: mb.id, account: accountId }, title: mail.mailboxName(mb)
    },
      icon(ROLE_ICON[mb.role] || 'folder', 18, 1.5),
      h('span', { class: 'sb-name' }, mail.mailboxName(mb)),
      h('span', { class: 'sb-count' + (unread > 0 ? ' unread' : ''), 'aria-label': unread ? t('{n} unread', { n: unread }) : null }, countText));
    btn.addEventListener('click', () => onOpenFolder(mb.id, accountId));
    const row = h('div', { class: 'folder-row', style: { '--depth': String(mb.depth || 0) } }, btn);
    if (!mb.role || mb.role === 'archive') {
      const more = h('button', { type: 'button', class: 'folder-more', title: t('Folder actions'), 'aria-label': t('Actions for {name}', { name: mb.name }) }, icon('dots', 14));
      more.addEventListener('click', e => {
        e.stopPropagation();
        const items = [{ label: t('New sub-folder'), icon: 'folder', run: () => newFolder(mb.id, accountId) }];
        if (!mb.role) {
          items.push({ label: t('Rename'), icon: 'drafts', run: () => renameFolder(mb, accountId) });
          items.push({ label: t('Delete'), icon: 'trash', danger: true, run: () => deleteFolder(mb, accountId) });
        }
        openMenu(more, items);
      });
      row.append(more);
    }
    // Drop a conversation onto a folder of the same mailbox to move it there.
    row.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('application/x-ironid-thread') || mail.viewAccount() !== accountId) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', e => {
      row.classList.remove('drop-target');
      const threadId = e.dataTransfer.getData('application/x-ironid-thread');
      if (threadId && mail.viewAccount() === accountId) { e.preventDefault(); onDropThread(threadId, mb.id); }
    });
    return row;
  });
}

function render() {
  const own = api.accountId();
  const rows = folderRows(own);
  $('#folderList').replaceChildren(...(rows.length ? rows : [h('div', { class: 'loading-text' }, t('No folders'))]));

  // Team mailboxes: one entry each; the viewed one shows its folders.
  const teams = api.mailAccounts().filter(a => !a.personal);
  $('#teamSection').classList.toggle('hidden', !teams.length);
  $('#teamList').replaceChildren(...teams.map(acc => {
    const team = mail.teamFor(acc.id);
    const set = mail.folderSet(acc.id);
    const inbox = set.byId.get(set.roles.inbox);
    const unread = inbox ? (inbox.unreadThreads || inbox.unreadEmails || 0) : 0;
    const open = mail.viewAccount() === acc.id;
    const btn = h('button', { type: 'button', class: 'sb-btn team-btn' + (open ? ' open' : ''), dataset: { account: acc.id }, title: team.email, 'aria-expanded': String(open) },
      icon('users', 18, 1.5), h('span', { class: 'sb-name' }, team.name || team.email),
      h('span', { class: 'sb-count' + (unread > 0 ? ' unread' : '') }, unread ? String(unread) : ''));
    btn.addEventListener('click', () => onOpenFolder(set.roles.inbox || null, acc.id));
    const box = h('div', { class: 'team-block' }, btn);
    if (open) box.append(h('div', { class: 'team-folders' }, ...folderRows(acc.id)));
    return box;
  }));
  renderLabels();
  updateTitle();
}

function renderLabels() {
  const v = mail.state.view;
  const rows = mail.state.labels.map(l => {
    const active = v.label === l.slug;
    const btn = h('button', { type: 'button', class: 'sb-btn' + (active ? ' active' : ''), 'aria-current': active ? 'page' : null, dataset: { label: l.slug }, title: l.name },
      h('span', { class: 'lbl-dot c-' + l.color }), h('span', { class: 'sb-name' }, l.name));
    btn.addEventListener('click', () => onOpenLabel(l.slug));
    const more = h('button', { type: 'button', class: 'folder-more', title: t('Label actions'), 'aria-label': t('Actions for label {name}', { name: l.name }) }, icon('dots', 14));
    more.addEventListener('click', e => { e.stopPropagation(); openMenu(more, labels.menuFor(l, () => { if (mail.state.view.label === l.slug) onOpenFolder(null, api.accountId()); })); });
    return h('div', { class: 'folder-row' }, btn, more);
  });
  $('#labelList').replaceChildren(...(rows.length ? rows : [h('div', { class: 'sb-hint' }, t('Labels group messages across folders.'))]));
}

export function updateTitle() {
  const own = mail.folderSet(api.accountId());
  const inbox = own.byId.get(own.roles.inbox);
  const n = inbox ? (inbox.unreadThreads || inbox.unreadEmails || 0) : 0;
  document.title = (n ? `(${n}) ` : '') + 'IRON ID Mail';
}

export function renderQuota(q) {
  const text = $('#quotaText'), fill = $('#quotaFill');
  if (!q) { text.textContent = t('No storage limit set'); fill.style.width = '0'; return; }
  const used = q.used || 0, limit = q.hardLimit || q.warnLimit || 0;
  if (!limit) { text.textContent = t('{size} used', { size: formatSize(used) }); fill.style.width = '0'; return; }
  const pct = Math.min(100, Math.round(used / limit * 100));
  text.textContent = t('{used} of {limit} ({pct}%)', { used: formatSize(used), limit: formatSize(limit), pct });
  fill.style.width = Math.max(pct, 1) + '%';
  fill.classList.toggle('warn', pct >= 80 && pct < 95);
  fill.classList.toggle('full', pct >= 95);
}
