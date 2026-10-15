/**
 * IRON ID — webmail labels.
 *
 * A label is a keyword on each message ("label:<slug>"), so it works across folders and
 * in mail apps that show keywords. This table only keeps each person's label names and colours.
 */
const crypto = require('crypto');
const db = require('./db');

const COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'];
const MAX_LABELS = 100;

class LabelError extends Error { constructor(m, status = 400) { super(m); this.userError = true; this.status = status; } }

function cleanName(v) {
  const n = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) throw new LabelError('Enter a label name.');
  return n;
}
function cleanColor(v) { return COLORS.includes(v) ? v : 'slate'; }
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function slugFor(name) {
  const s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return s || 'l' + crypto.randomBytes(3).toString('hex');
}

async function list(email) {
  const r = await db.query('SELECT slug, name, color FROM cp.labels WHERE email = $1 ORDER BY lower(name)', [email]);
  return r.rows;
}

async function create(email, { name, color }) {
  name = cleanName(name);
  const existing = await list(email);
  if (existing.length >= MAX_LABELS) throw new LabelError(`You can have up to ${MAX_LABELS} labels.`);
  if (existing.some(l => l.name.toLowerCase() === name.toLowerCase())) throw new LabelError('You already have a label with that name.');
  const base = slugFor(name);
  let slug = base;
  for (let i = 2; existing.some(l => l.slug === slug); i++) slug = `${base}-${i}`.slice(0, 40);
  await db.query('INSERT INTO cp.labels (email, slug, name, color) VALUES ($1, $2, $3, $4)', [email, slug, name, cleanColor(color)]);
  return { slug, name, color: cleanColor(color) };
}

async function update(email, { slug, name, color }) {
  slug = String(slug || '');
  if (!SLUG_RE.test(slug)) throw new LabelError('That label was not found.', 404);
  name = cleanName(name);
  const clash = await db.query('SELECT 1 FROM cp.labels WHERE email = $1 AND lower(name) = lower($2) AND slug <> $3', [email, name, slug]);
  if (clash.rows.length) throw new LabelError('You already have a label with that name.');
  const r = await db.query('UPDATE cp.labels SET name = $3, color = $4 WHERE email = $1 AND slug = $2', [email, slug, name, cleanColor(color)]);
  if (!r.rowCount) throw new LabelError('That label was not found.', 404);
  return { slug, name, color: cleanColor(color) };
}

async function remove(email, { slug }) {
  const r = await db.query('DELETE FROM cp.labels WHERE email = $1 AND slug = $2', [email, String(slug || '')]);
  if (!r.rowCount) throw new LabelError('That label was not found.', 404);
  return { ok: true };
}

module.exports = { list, create, update, remove, COLORS };
