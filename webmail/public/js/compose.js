// Composer: recipients with suggestions, identities, attachments, draft autosave, replies.

import * as api from './api.js';
import * as mail from './mail.js';
import { messageText } from './reader.js';
import { h, $, icon, toast, dialog, debounce, parseAddresses, formatAddress, formatAddressList, longDate, formatSize, displayName } from './util.js';

const AUTOSAVE_MS = 2500;
let c = null;          // the message being written
let saveChain = Promise.resolve();
let attSeq = 0;
let onSent = () => {};

const modal = () => $('#composeModal');
export const isOpen = () => modal().classList.contains('open');

export function init({ sent }) {
  onSent = sent;
  $('#cmpClose').addEventListener('click', () => close());
  $('#cmpDiscard').addEventListener('click', () => discard());
  $('#sendBtn').addEventListener('click', () => send());
  $('#cmpShowCc').addEventListener('click', () => showRow('Cc'));
  $('#cmpShowBcc').addEventListener('click', () => showRow('Bcc'));
  $('#cmpAttachBtn').addEventListener('click', () => $('#cmpFile').click());
  $('#cmpFile').addEventListener('change', e => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; });
  for (const id of ['cmpTo', 'cmpCc', 'cmpBcc', 'cmpSub', 'cmpBody', 'cmpFrom']) {
    $('#' + id).addEventListener('input', changed);
    $('#' + id).addEventListener('change', changed);
  }
  for (const id of ['cmpTo', 'cmpCc', 'cmpBcc']) setupSuggest($('#' + id));
  modal().addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    else if (e.key === 'Escape' && !$('#cmpSuggest').classList.contains('hidden')) { /* handled by suggest */ }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  // Drop files onto the composer to attach them.
  const bg = modal();
  bg.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); bg.classList.add('drag-over'); } });
  bg.addEventListener('dragleave', e => { if (e.target === bg) bg.classList.remove('drag-over'); });
  bg.addEventListener('drop', e => {
    bg.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); }
  });
  // Try to keep unsaved text if the page is closed.
  window.addEventListener('pagehide', () => { if (c && c.dirty) saveDraft({ keepalive: true }); });
}

function showRow(which) {
  $('#cmp' + which + 'Row').classList.remove('hidden');
  $('#cmpShow' + which).classList.add('hidden');
  $('#cmp' + which).focus();
}

const autosave = debounce(() => { if (c && c.dirty) saveDraft(); }, AUTOSAVE_MS);
function changed() {
  if (!c) return;
  c.dirty = true;
  setStatus('');
  autosave();
}

function setStatus(text) { $('#cmpStatus').textContent = text; }
function setAlert(text) {
  const a = $('#composeAlert');
  if (!text) { a.className = 'hidden'; a.textContent = ''; return; }
  a.className = 'cmp-alert'; a.textContent = text;
}

/* ——— Identities ——— */
function identities() {
  const list = mail.state.identities.length ? mail.state.identities : [{ id: null, email: mail.state.user.email, name: mail.state.user.name }];
  return list;
}
function identity() {
  const id = $('#cmpFrom').value;
  return identities().find(i => String(i.id) === id) || identities()[0];
}
function fillFrom(identityId) {
  const sel = $('#cmpFrom');
  sel.replaceChildren(...identities().map(i => h('option', { value: String(i.id) }, i.name ? `${i.name} <${i.email}>` : i.email)));
  if (identityId) sel.value = String(identityId);
  sel.disabled = identities().length < 2;
}
function signature(ident) {
  const s = ident && (ident.textSignature || '').trim();
  return s ? '\n\n-- \n' + s : '';
}

/* ——— Open ——— */
/**
 * opts: { to, cc, bcc (arrays of {name,email}), subject, body, attachments, identityId,
 *         inReplyTo, references, original: {id, keyword}, draftId, title, focus }
 */
export async function open(opts = {}) {
  if (c && c.dirty) await saveDraft();
  c = {
    draftId: opts.draftId || null,
    inReplyTo: opts.inReplyTo || null,
    references: opts.references || null,
    original: opts.original || null,
    attachments: (opts.attachments || []).map(a => ({ key: ++attSeq, name: a.name || 'attachment', type: a.type, size: a.size, blobId: a.blobId, status: 'done' })),
    dirty: false
  };
  fillFrom(opts.identityId);
  $('#cmpTo').value = formatAddressList(opts.to);
  $('#cmpCc').value = formatAddressList(opts.cc);
  $('#cmpBcc').value = formatAddressList(opts.bcc);
  for (const w of ['Cc', 'Bcc']) {
    const has = !!$('#cmp' + w).value;
    $('#cmp' + w + 'Row').classList.toggle('hidden', !has);
    $('#cmpShow' + w).classList.toggle('hidden', has);
  }
  $('#cmpSub').value = opts.subject || '';
  $('#cmpBody').value = opts.body !== undefined ? opts.body : signature(identity());
  $('#composeTitle').textContent = opts.title || 'New message';
  setAlert(''); setStatus(c.draftId ? 'Draft' : '');
  renderAttachments();
  modal().classList.add('open');
  modal().setAttribute('aria-hidden', 'false');
  const sendBtn = $('#sendBtn'); sendBtn.disabled = false;
  const focus = opts.focus || (!$('#cmpTo').value ? 'to' : 'body');
  setTimeout(() => {
    // Don't move the cursor if the person already clicked into a field.
    const active = document.activeElement;
    if (active && modal().contains(active) && active !== document.body) return;
    const el = focus === 'to' ? $('#cmpTo') : $('#cmpBody');
    el.focus();
    if (el === $('#cmpBody')) { el.setSelectionRange(0, 0); el.scrollTop = 0; }
  }, 30);
  mail.loadAddressBook().catch(() => {});
}

/** Reply / reply all / forward. Messages of a team mailbox are answered from the person's own mailbox. */
export async function openReply(kind, e) {
  if (!e) return;
  const fromAccount = mail.viewAccount();
  const mine = new Set(identities().map(i => (i.email || '').toLowerCase()).concat([mail.state.user.email.toLowerCase()]));
  const notMe = a => a && a.email && !mine.has(a.email.toLowerCase());
  const fromMe = (e.from || []).some(a => !notMe(a));
  const dedupe = list => { const s = new Set(); return list.filter(a => { const k = a.email.toLowerCase(); if (s.has(k)) return false; s.add(k); return true; }); };
  // Answer from the address the message was sent to, when it is one of ours.
  const ident = identities().find(i => [...(e.to || []), ...(e.cc || []), ...(e.bcc || [])].some(a => a.email && i.email && a.email.toLowerCase() === i.email.toLowerCase())) || identities()[0];
  const sig = signature(ident);
  const subj = e.subject || '';
  const from = (e.from && e.from[0]) || { email: '' };
  const quoted = messageText(e).replace(/\r\n/g, '\n').trimEnd();

  if (kind === 'forward') {
    const header = ['---------- Forwarded message ----------', `From: ${formatAddress(from)}`, `Date: ${longDate(e.receivedAt)}`, `Subject: ${subj}`,
      `To: ${formatAddressList(e.to)}`, e.cc && e.cc.length ? `Cc: ${formatAddressList(e.cc)}` : null].filter(Boolean).join('\n');
    let attachments = (e.attachments || []).filter(a => a.blobId);
    if (attachments.length && fromAccount !== api.accountId()) {
      // Files of a team mailbox are copied into the person's own mailbox first.
      try {
        const map = await mail.copyBlobs(fromAccount, attachments.map(a => a.blobId));
        const missing = attachments.filter(a => !map.has(a.blobId)).length;
        attachments = attachments.filter(a => map.has(a.blobId)).map(a => ({ ...a, blobId: map.get(a.blobId) }));
        if (missing) toast(`${missing} attachment${missing > 1 ? 's' : ''} could not be included`, false);
      } catch (err) { attachments = []; toast('The attachments could not be included: ' + err.message, false); }
    }
    return open({
      identityId: ident.id, subject: /^(fwd?|tr):/i.test(subj) ? subj : 'Fwd: ' + subj,
      body: '\n' + sig + '\n\n' + header + '\n\n' + quoted,
      attachments,
      original: { id: e.id, keyword: '$forwarded', accountId: fromAccount }, title: 'Forward', focus: 'to'
    });
  }
  let to, cc = [];
  if (fromMe) {
    to = e.to || [];
    if (kind === 'replyAll') cc = e.cc || [];
  } else {
    to = (e.replyTo && e.replyTo.length ? e.replyTo : e.from) || [];
    if (kind === 'replyAll') {
      to = dedupe([...to, ...(e.to || []).filter(notMe)]);
      cc = dedupe((e.cc || []).filter(notMe)).filter(a => !to.some(t => t.email.toLowerCase() === a.email.toLowerCase()));
    }
  }
  const lines = quoted.split('\n').map(l => '> ' + l).join('\n');
  const refs = [...(e.references || []), ...(e.messageId || [])].filter((v, i, a) => v && a.indexOf(v) === i).slice(-20);
  return open({
    identityId: ident.id, to, cc,
    subject: /^(re|aw|réf?):/i.test(subj) ? subj : 'Re: ' + subj,
    body: '\n' + sig + '\n\nOn ' + longDate(e.receivedAt) + ', ' + (displayName(from) || from.email) + ' wrote:\n' + lines,
    inReplyTo: e.messageId && e.messageId.length ? e.messageId : null,
    references: refs.length ? refs : null,
    original: { id: e.id, keyword: '$answered', accountId: fromAccount },
    title: kind === 'replyAll' ? 'Reply all' : 'Reply', focus: 'body'
  });
}

/** Re-opens a saved draft for editing. */
export function openDraft(e) {
  const values = e.bodyValues || {};
  const text = (e.textBody || []).map(p => values[p.partId] && values[p.partId].value).filter(Boolean).join('\n');
  const ident = identities().find(i => e.from && e.from[0] && i.email && i.email.toLowerCase() === (e.from[0].email || '').toLowerCase());
  return open({
    draftId: e.id, identityId: ident && ident.id, to: e.to, cc: e.cc, bcc: e.bcc, subject: e.subject || '',
    body: text || messageText(e), attachments: (e.attachments || []).filter(a => a.blobId),
    inReplyTo: e.inReplyTo, references: e.references, title: 'Draft'
  });
}

/* ——— Attachments ——— */
function renderAttachments() {
  const box = $('#cmpAtt');
  box.replaceChildren(...c.attachments.map(a => {
    const x = h('button', { type: 'button', class: 'att-x', title: 'Remove', 'aria-label': 'Remove ' + a.name }, '×');
    x.addEventListener('click', () => { c.attachments = c.attachments.filter(y => y.key !== a.key); renderAttachments(); changed(); });
    const status = a.status === 'uploading' ? Math.round((a.progress || 0) * 100) + '%' : a.status === 'failed' ? 'failed' : formatSize(a.size);
    return h('span', { class: 'att' + (a.status === 'uploading' ? ' uploading' : '') + (a.status === 'failed' ? ' failed' : ''), title: a.error || a.name },
      icon('clip', 13), h('span', { class: 'att-name' }, a.name), h('span', { class: 'att-size' }, status), x);
  }));
}

function addFiles(files) {
  if (!c) return;
  const limit = (api.mailLimits().maxSizeAttachmentsPerEmail) || 50e6;
  for (const f of files) {
    const total = c.attachments.reduce((s, a) => s + (a.size || 0), 0) + f.size;
    if (total > limit) { toast(`Attachments are limited to ${formatSize(limit)} per message`, false); break; }
    const a = { key: ++attSeq, name: f.name, type: f.type || 'application/octet-stream', size: f.size, status: 'uploading', progress: 0 };
    c.attachments.push(a);
    const mine = c;
    api.upload(f, p => { a.progress = p; if (mine === c) renderAttachments(); })
      .then(r => { a.blobId = r.blobId; a.type = r.type || a.type; a.status = 'done'; if (mine === c) { renderAttachments(); changed(); } })
      .catch(err => { a.status = 'failed'; a.error = err.message; if (mine === c) { renderAttachments(); toast(err.message, false); } });
  }
  renderAttachments();
}

/* ——— Building the message ——— */
function fields() {
  const to = parseAddresses($('#cmpTo').value), cc = parseAddresses($('#cmpCc').value), bcc = parseAddresses($('#cmpBcc').value);
  return { to, cc, bcc, subject: $('#cmpSub').value.trim(), body: $('#cmpBody').value };
}

function isEmpty(f) {
  const sig = signature(identity()).trim();
  return !f.to.list.length && !f.cc.list.length && !f.bcc.list.length && !f.subject && (!f.body.trim() || f.body.trim() === sig) && !c.attachments.length;
}

function buildEmail(f, draftsId) {
  const ident = identity();
  const email = {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true, $seen: true },
    from: [ident.name ? { name: ident.name, email: ident.email } : { email: ident.email }],
    subject: f.subject,
    bodyValues: { b: { value: f.body.replace(/\r?\n/g, '\r\n') } },
    textBody: [{ partId: 'b', type: 'text/plain' }]
  };
  if (f.to.list.length) email.to = f.to.list;
  if (f.cc.list.length) email.cc = f.cc.list;
  if (f.bcc.list.length) email.bcc = f.bcc.list;
  if (c.inReplyTo) email.inReplyTo = c.inReplyTo;
  if (c.references) email.references = c.references;
  const atts = c.attachments.filter(a => a.status === 'done' && a.blobId);
  if (atts.length) email.attachments = atts.map(a => ({ blobId: a.blobId, type: a.type || 'application/octet-stream', name: a.name, disposition: 'attachment' }));
  return email;
}

/** Saves the draft (replacing the previous saved copy). Calls are queued, never parallel. */
function saveDraft({ keepalive = false } = {}) {
  if (!c) return Promise.resolve();
  const mine = c;
  const run = async () => {
    if (!mine.dirty) return;
    const f = fields();
    if (isEmpty(f) && !mine.draftId) { mine.dirty = false; return; }
    mine.dirty = false;
    if (mine === c) setStatus('Saving…');
    try {
      const draftsId = await mail.ensureRoleMailbox('drafts', { personal: true });
      const acc = api.accountId();
      const email = buildEmail(f, draftsId);
      if (keepalive) {
        // Page is closing: best effort, one request, no waiting.
        fetch('/proxy/jmap', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          // No destroy here: if the create failed, the previous copy must survive.
          body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: [['Email/set', { accountId: acc, create: { d: email } }, 's']] }) });
        return;
      }
      const r = await api.call([['Email/set', { accountId: acc, create: { d: email } }, 's']]);
      api.checkSet(r.get('s'), 'save the draft');
      const old = mine.draftId;
      mine.draftId = r.get('s').created.d.id;
      if (old) api.call([['Email/set', { accountId: acc, destroy: [old] }, 'x']]).catch(() => {});
      if (mine === c) setStatus('Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      mail.refreshCountsSoon();
    } catch (e) {
      mine.dirty = true;
      if (mine === c) setStatus('Not saved');
      if (!(e instanceof api.SessionEndedError)) console.warn('[draft]', e);
    }
  };
  saveChain = saveChain.then(run, run);
  return saveChain;
}

/* ——— Send / close / discard ——— */
async function send() {
  if (!c) return;
  const btn = $('#sendBtn');
  if (btn.disabled) return;
  setAlert('');
  const f = fields();
  const bad = [...f.to.invalid, ...f.cc.invalid, ...f.bcc.invalid];
  if (bad.length) return setAlert('These are not valid email addresses: ' + bad.join(', '));
  const rcpts = [...f.to.list, ...f.cc.list, ...f.bcc.list];
  if (!rcpts.length) { setAlert('Add at least one recipient.'); $('#cmpTo').focus(); return; }
  if (c.attachments.some(a => a.status === 'uploading')) return setAlert('Please wait until the attachments have finished uploading.');
  if (c.attachments.some(a => a.status === 'failed')) return setAlert('An attachment failed to upload. Remove it or try again.');
  if (!f.subject) {
    const ok = await dialog({ title: 'No subject', text: 'Send this message without a subject?', okLabel: 'Send anyway' });
    if (!ok) return;
  }
  if (/\b(attach|attached|attachment|pièce jointe|ci-joint|مرفق)/i.test(f.body.split(/\n>|\n-- \n/)[0]) && !c.attachments.length) {
    const ok = await dialog({ title: 'Forgot the attachment?', text: 'Your message mentions an attachment, but nothing is attached. Send anyway?', okLabel: 'Send anyway' });
    if (!ok) return;
  }
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Sending…';
  autosave.cancel();
  const mine = c;
  try {
    await saveChain; // let a running save finish first
    const [draftsId, sentId] = await Promise.all([mail.ensureRoleMailbox('drafts', { personal: true }), mail.ensureRoleMailbox('sent', { personal: true })]);
    const ident = identity();
    const acc = api.accountId();
    const email = buildEmail(f, draftsId);
    const seen = new Set();
    const rcptTo = rcpts.filter(a => { const k = a.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).map(a => ({ email: a.email }));
    const calls = [
      ['Email/set', { accountId: acc, create: { m: email } }, 'e'],
      ['EmailSubmission/set', {
        accountId: acc,
        create: { s: { identityId: ident.id, emailId: '#m', envelope: { mailFrom: { email: ident.email }, rcptTo } } },
        onSuccessUpdateEmail: { '#s': { ['mailboxIds/' + draftsId]: null, ['mailboxIds/' + sentId]: true, 'keywords/$draft': null } }
      }, 'u']
    ];
    const r = await api.call(calls, { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'], allowErrors: true });
    const created = r.get('e');
    if (!created || created.error) throw new Error((created && created.error && created.error.description) || 'The message could not be created.');
    api.checkSet(created, 'create the message');
    const newId = created.created.m.id;
    // The submission and the server's follow-up Email/set share the call id 'u'.
    const subResp = r.responses.find(x => x.id === 'u' && (x.name === 'EmailSubmission/set' || x.name === 'error'));
    const sub = subResp && subResp.args;
    const subErr = !sub || sub.error ? ((sub && sub.error) || { type: 'serverFail', description: 'no answer from the mail server' }) : (sub.notCreated && sub.notCreated.s);
    if (subErr) {
      // Keep what was written as a draft so nothing is lost.
      const old = mine.draftId; mine.draftId = newId;
      if (old && old !== newId) api.call([['Email/set', { accountId: acc, destroy: [old] }, 'x']]).catch(() => {});
      throw new Error(sendErrorText(subErr));
    }
    // Sent. Check that it was filed in Sent (otherwise it would still look like a draft).
    const follow = r.responses.find(x => x.id === 'u' && x.name === 'Email/set');
    const moved = follow && follow.args && follow.args.updated && Object.prototype.hasOwnProperty.call(follow.args.updated, newId);
    if (!moved) {
      api.call([['Email/set', { accountId: acc, update: { [newId]: { ['mailboxIds/' + draftsId]: null, ['mailboxIds/' + sentId]: true, 'keywords/$draft': null } } }, 'f']])
        .then(x => api.checkSet(x.get('f'), 'file the message in Sent'))
        .catch(() => toast('Sent, but it could not be filed in the Sent folder', false));
    }
    const after = [];
    if (mine.draftId && mine.draftId !== newId) after.push(['Email/set', { accountId: acc, destroy: [mine.draftId] }, 'd']);
    if (mine.original && mine.original.id) after.push(['Email/set', { accountId: mine.original.accountId || acc, update: { [mine.original.id]: { ['keywords/' + mine.original.keyword]: true } } }, 'k']);
    if (after.length) api.call(after, { allowErrors: true }).catch(() => {});
    mine.dirty = false;
    if (mine === c) hide();
    c = mine === c ? null : c;
    toast('Message sent');
    onSent();
  } catch (e) {
    if (!(e instanceof api.SessionEndedError)) setAlert(e.message);
    else setAlert('Your session ended. Sign in again, then press Send. Your message is still here.');
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Send';
  }
}

function sendErrorText(err) {
  const t = err.type || '';
  if (t === 'forbiddenFrom') return 'You are not allowed to send from this address.';
  if (t === 'forbiddenToSend') return 'Sending is not allowed for this mailbox right now.';
  if (t === 'invalidRecipients') return 'Some recipients were refused: ' + ((err.invalidRecipients || []).join(', ') || 'check the addresses');
  if (t === 'tooLarge') return 'The message is too large to send.';
  if (t === 'tooManyRecipients') return 'Too many recipients.';
  return 'Could not send: ' + (err.description || t || 'unknown error') + '. Your message was kept as a draft.';
}

function hide() {
  modal().classList.remove('open');
  modal().setAttribute('aria-hidden', 'true');
  $('#cmpSuggest').classList.add('hidden');
}

export async function close() {
  if (!c) { hide(); return; }
  autosave.cancel();
  const mine = c;
  if (mine.dirty) {
    setStatus('Saving…');
    await saveDraft();
    if (mine.dirty) {
      // Keep the window open: closing now would lose what was written.
      if (mine === c) setStatus('Not saved');
      toast('Could not save the draft. Check your connection, then try again.', false);
      return;
    }
    if (mine.draftId) toast('Draft saved');
  }
  hide();
  if (c === mine) c = null;
}

async function discard() {
  if (!c) return hide();
  autosave.cancel();
  const mine = c;
  c = null;
  hide();
  await saveChain.catch(() => {});
  if (mine.draftId) {
    try { await api.call([['Email/set', { accountId: api.accountId(), destroy: [mine.draftId] }, 'x']]); } catch (e) { /* already gone */ }
    mail.refreshCountsSoon();
  }
  toast('Draft discarded');
  onSent();
}

/* ——— Address suggestions ——— */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let sug = { input: null, items: [], index: 0 };

function setupSuggest(input) {
  input.addEventListener('input', () => suggest(input));
  input.addEventListener('focus', () => { mail.loadAddressBook().catch(() => {}); });
  input.addEventListener('blur', () => setTimeout(() => { if (sug.input === input) hideSuggest(); }, 150));
  input.addEventListener('keydown', e => {
    const box = $('#cmpSuggest');
    if (box.classList.contains('hidden') || sug.input !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sug.index = (sug.index + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
      paintSuggest();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (sug.items[sug.index]) { e.preventDefault(); pick(sug.items[sug.index]); }
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideSuggest(); }
  });
}

async function suggest(input) {
  const v = input.value;
  const token = v.slice(v.lastIndexOf(',') + 1).trim();
  if (token.length < 1) return hideSuggest();
  const book = await mail.loadAddressBook().catch(() => []);
  const q = norm(token);
  const already = new Set(parseAddresses(v.slice(0, v.lastIndexOf(',') + 1)).list.map(a => a.email.toLowerCase()));
  const items = book.filter(a => !already.has(a.email.toLowerCase()) &&
    (norm(a.email).startsWith(q) || norm(a.name).split(/\s+/).some(w => w.startsWith(q)) || norm(a.email).includes(q))).slice(0, 8);
  if (!items.length || input !== document.activeElement) return hideSuggest();
  sug = { input, items, index: 0 };
  const box = $('#cmpSuggest');
  const body = input.closest('.compose-body');
  const r = input.getBoundingClientRect(), b = body.getBoundingClientRect();
  box.style.left = (r.left - b.left) + 'px';
  box.style.top = (r.bottom - b.top + body.scrollTop + 2) + 'px';
  box.classList.remove('hidden');
  paintSuggest();
}

function paintSuggest() {
  const box = $('#cmpSuggest');
  box.replaceChildren(...sug.items.map((a, i) => {
    const li = h('li', { role: 'option', 'aria-selected': String(i === sug.index) }, a.name || a.email, a.name ? h('small', {}, a.email) : null);
    li.addEventListener('mousedown', e => { e.preventDefault(); pick(a); });
    return li;
  }));
}

function pick(a) {
  const input = sug.input;
  const v = input.value;
  const head = v.slice(0, v.lastIndexOf(',') + 1);
  input.value = (head ? head.trimEnd() + ' ' : '') + formatAddress(a) + ', ';
  hideSuggest();
  input.focus();
  changed();
}

function hideSuggest() { $('#cmpSuggest').classList.add('hidden'); sug = { input: null, items: [], index: 0 }; }

export function flush() { return c && c.dirty ? saveDraft() : Promise.resolve(); }
export const isDirty = () => !!(c && c.dirty);
