// Talks to the mail engine (JMAP, RFC 8620/8621) through the gateway's /proxy.
// The browser never holds the mailbox password: the gateway adds the signed-in
// user's credentials from the server-side session (HttpOnly cookie).

import { t } from './i18n.js';

const CORE = 'urn:ietf:params:jmap:core';
export const CAP = {
  core: CORE,
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
  quota: 'urn:ietf:params:jmap:quota',
  contacts: 'urn:ietf:params:jmap:contacts'
};
const DEFAULT_USING = [CAP.core, CAP.mail, CAP.submission];

let session = null;
const listeners = new Set();

/** Subscribes to 'session-ended' (the gateway no longer knows this browser). */
export function onSessionEnded(fn) { listeners.add(fn); }
function sessionEnded() { for (const fn of listeners) { try { fn(); } catch (e) { /* ignore */ } } }

export class SessionEndedError extends Error {
  constructor() { super(t('Your session has ended. Please sign in again.')); this.name = 'SessionEndedError'; }
}

export class JmapError extends Error {
  constructor(type, description, method) {
    super(description || type || t('The mail server refused the request'));
    this.name = 'JmapError';
    this.type = type;
    this.method = method;
  }
}

/** The engine's absolute URLs (https://mail.example/jmap/...) become same-site /proxy/jmap/... paths. */
function proxied(url) {
  return '/proxy' + String(url).replace(/^[a-z]+:\/\/[^/]+/i, '');
}

export async function loadSession() {
  const res = await fetch('/proxy/jmap/session', { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(t('The mail server is not reachable (HTTP {status})', { status: res.status }));
  const s = await res.json();
  if (!s || !s.username) return null;
  session = s;
  return s;
}

export function getSession() { return session; }
export function clearSession() { session = null; }

/** The person's own mail account (drafts, sending, uploads, settings live here). */
export function accountId() {
  if (!session) return null;
  return session.primaryAccounts[CAP.mail] || Object.keys(session.accounts)[0];
}

/** The account being looked at: the person's own, or a team mailbox they belong to. */
let viewAccountId = null;
export function setViewAccount(id) { viewAccountId = id || null; }
export function viewAccount() { return viewAccountId || accountId(); }

/** Mail accounts in this session: own first, then team (shared) mailboxes. */
export function mailAccounts() {
  if (!session) return [];
  const own = accountId();
  const list = [{ id: own, name: session.username, personal: true }];
  for (const [id, a] of Object.entries(session.accounts || {})) {
    if (id === own || !a.accountCapabilities || !a.accountCapabilities[CAP.mail]) continue;
    list.push({ id, name: String(a.name || id), personal: false, readOnly: !!a.isReadOnly });
  }
  return list;
}

export function hasCapability(cap) {
  if (!session) return false;
  const acc = session.accounts[accountId()];
  return !!(session.capabilities[cap] && (!acc || !acc.accountCapabilities || acc.accountCapabilities[cap] !== undefined));
}

export function coreLimits() {
  return (session && session.capabilities[CORE]) || { maxSizeUpload: 50000000, maxCallsInRequest: 16, maxObjectsInGet: 500 };
}

export function mailLimits() {
  const acc = session && session.accounts[accountId()];
  return (acc && acc.accountCapabilities && acc.accountCapabilities[CAP.mail]) || {};
}

/**
 * Runs JMAP method calls. Returns a Map from call id to the method's arguments.
 * Throws JmapError if any call failed (unless allowErrors is set: then failed
 * calls map to { error: {type, description} }).
 */
export async function call(methodCalls, { using = DEFAULT_USING, allowErrors = false } = {}) {
  let res;
  try {
    res = await fetch('/proxy/jmap', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ using, methodCalls })
    });
  } catch (e) {
    throw new Error(t('Network problem: the mail server could not be reached.'));
  }
  if (res.status === 401) { sessionEnded(); throw new SessionEndedError(); }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.detail || j.error || j.title || ''; } catch (e) { /* not JSON */ }
    throw new Error(detail || t('The mail server returned an error (HTTP {status})', { status: res.status }));
  }
  const data = await res.json();
  // A call can produce more than one response with the same id (for example the
  // implicit Email/set after EmailSubmission/set). The map keeps the first one;
  // out.responses keeps all of them with their method names.
  const out = new Map();
  out.responses = [];
  for (const [name, args, id] of data.methodResponses || []) {
    const value = name === 'error' ? { error: args } : args;
    out.responses.push({ name, id, args: value });
    if (name === 'error' && !allowErrors && !out.has(id)) throw new JmapError(args.type, args.description, id);
    if (!out.has(id)) out.set(id, value);
  }
  return out;
}

// checkSet() messages, by the `what` its callers pass. Callers keep `what` in English; the whole sentence is translated here.
const SET_FAILED = {
  'change': t('Could not change ({type})'),
  'save your profile': t('Could not save your profile ({type})'),
  'save the automatic reply': t('Could not save the automatic reply ({type})'),
  'create the folder': t('Could not create the folder ({type})'),
  'rename the folder': t('Could not rename the folder ({type})'),
  'assign the message': t('Could not assign the message ({type})'),
  'remove the label': t('Could not remove the label ({type})'),
  'update the message': t('Could not update the message ({type})'),
  'move the message': t('Could not move the message ({type})'),
  'undo': t('Could not undo ({type})'),
  'remove the message from the folder': t('Could not remove the message from the folder ({type})'),
  'delete the message': t('Could not delete the message ({type})'),
  'mark messages as read': t('Could not mark messages as read ({type})'),
  'save the draft': t('Could not save the draft ({type})'),
  'create the message': t('Could not create the message ({type})'),
  'file the message in Sent': t('Could not file the message in Sent ({type})')
};

/** Throws if a /set response did not create/update/destroy what was asked. */
export function checkSet(result, what = 'change') {
  const failed = { ...(result.notCreated || {}), ...(result.notUpdated || {}), ...(result.notDestroyed || {}) };
  const keys = Object.keys(failed);
  if (keys.length) {
    const e = failed[keys[0]];
    const msg = Object.prototype.hasOwnProperty.call(SET_FAILED, what)
      ? SET_FAILED[what].replace('{type}', () => e.type)
      : t('Could not {action} ({type})', { action: what, type: e.type });
    throw new JmapError(e.type, e.description || msg);
  }
  return result;
}

export function downloadUrl(blobId, name, type, { inline = false } = {}) {
  if (!session) return '#';
  const tpl = session.downloadUrl;
  const url = tpl
    .replace('{accountId}', encodeURIComponent(viewAccount()))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', encodeURIComponent(name || 'attachment'))
    .replace('{type}', encodeURIComponent(type || 'application/octet-stream'));
  return proxied(url) + (inline ? (url.includes('?') ? '&' : '?') + 'inline=1' : '');
}

/** Fetches a blob (for inline images) and returns an object URL. */
const RASTER = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
export async function fetchBlobUrl(blobId, type) {
  // Only plain pictures: an SVG turned into a same-site blob page could be abused.
  if (!RASTER.test(String(type || ''))) throw new Error('unsupported picture type');
  type = String(type).toLowerCase();
  const res = await fetch(downloadUrl(blobId, 'inline', type, { inline: true }), { credentials: 'same-origin' });
  if (res.status === 401) { sessionEnded(); throw new SessionEndedError(); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  return URL.createObjectURL(new Blob([blob], { type }));
}

/** Uploads a file. Resolves { blobId, type, size }. */
export function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (!session) return reject(new Error(t('Not signed in')));
    const max = coreLimits().maxSizeUpload;
    if (max && file.size > max) {
      return reject(new Error(t('"{name}" is larger than the {size} MB limit', { name: file.name, size: Math.round(max / 1e6) })));
    }
    const url = proxied(session.uploadUrl.replace('{accountId}', encodeURIComponent(accountId())));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 401) { sessionEnded(); return reject(new SessionEndedError()); }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(t('Upload failed (HTTP {status})', { status: xhr.status })));
      try {
        const r = JSON.parse(xhr.responseText);
        resolve({ blobId: r.blobId, type: r.type || file.type, size: r.size || file.size });
      } catch (e) { reject(new Error(t('Upload failed: unexpected answer'))); }
    };
    xhr.onerror = () => reject(new Error(t('Upload failed: network problem')));
    xhr.send(file);
  });
}

/** Opens the engine's push channel (RFC 8620 §7.3). Returns the EventSource or null. */
export function openEventSource(types = '*') {
  if (!session || !session.eventSourceUrl || typeof EventSource === 'undefined') return null;
  const url = session.eventSourceUrl
    .replace('{types}', encodeURIComponent(types))
    .replace('{closeafter}', 'no')
    .replace('{ping}', '20');
  return new EventSource(proxied(url), { withCredentials: true });
}

export async function signIn(email, password, code = '', lang = '') {
  const body = { email, password };
  if (code) body.code = code;
  if (lang) body.lang = lang; // chosen on the sign-in screen: saved to the account
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(data.error || t('Sign-in failed (HTTP {status})', { status: res.status })), { mfaRequired: !!data.mfaRequired });
  return data;
}

export async function signOut() {
  try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* offline */ }
  session = null;
}

/** Calls the gateway's /account/... routes. Errors carry the server's message (and flags). */
export async function account(path, body = null) {
  let res;
  try {
    res = await fetch('/account/' + path, {
      method: body === null ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === null ? {} : { 'Content-Type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch (e) { throw new Error(t('Network problem: the server could not be reached.')); }
  let data = {};
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (res.status === 401) { sessionEnded(); throw new SessionEndedError(); }
  if (!res.ok) throw Object.assign(new Error(data.error || t('Server error (HTTP {status})', { status: res.status })), { data });
  return data;
}

export async function changePassword(currentPassword, newPassword, code = '') {
  return account('password', { currentPassword, newPassword, code });
}
