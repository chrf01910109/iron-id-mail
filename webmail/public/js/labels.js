// Labels: names and colours are kept by the gateway (/account/labels); the label itself is a
// keyword on each message ("label:<slug>"), so one message can have several labels.

import * as api from './api.js';
import * as mail from './mail.js';
import { toast, dialog } from './util.js';
import { t } from './i18n.js';

export const COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'orange', 'pink', 'indigo', 'slate'];
const COLOR_NAMES = { slate: t('Grey'), red: t('Red'), orange: t('Orange'), amber: t('Yellow'), green: t('Green'), teal: t('Teal'), blue: t('Blue'), indigo: t('Indigo'), purple: t('Purple'), pink: t('Pink') };

function sortLabels() { mail.state.labels.sort((a, b) => a.name.localeCompare(b.name)); }
const validName = v => !v ? t('Please enter a name.') : v.length > 40 ? t('Use 40 characters or fewer.') : null;

/** Asks for a name and creates the label. Returns it, or null. */
export async function promptNew() {
  const name = await dialog({ title: t('New label'), text: t('Label name'), input: '', okLabel: t('Create'), validate: validName });
  if (!name) return null;
  const color = COLORS[mail.state.labels.length % COLORS.length];
  try {
    const l = await api.account('labels', { name, color });
    mail.state.labels.push(l); sortLabels();
    mail.emit('labels');
    toast(t('Label "{name}" created', { name: l.name }));
    return l;
  } catch (e) { toast(e.message, false); return null; }
}

/** Sidebar menu for one label: rename, colour, delete. */
export function menuFor(l, onDeleted) {
  const save = async patch => {
    try {
      const r = await api.account('labels/update', { slug: l.slug, name: l.name, color: l.color, ...patch });
      Object.assign(l, r); sortLabels(); mail.emit('labels'); mail.emit('list');
    } catch (e) { toast(e.message, false); }
  };
  return [
    { label: t('Rename'), icon: 'drafts', run: async () => {
      const name = await dialog({ title: t('Rename label'), text: t('New name'), input: l.name, okLabel: t('Rename'), validate: validName });
      if (name && name !== l.name) save({ name });
    } },
    { title: t('Colour') },
    ...COLORS.map(c => ({ label: COLOR_NAMES[c], dot: c, checked: l.color === c, run: () => save({ color: c }) })),
    { label: t('Delete label'), icon: 'trash', danger: true, run: async () => {
      const ok = await dialog({ title: t('Delete label'), text: t('Delete the label "{name}"? The messages stay where they are; only the label is removed.', { name: l.name }), okLabel: t('Delete'), danger: true });
      if (!ok) return;
      try {
        await api.account('labels/delete', { slug: l.slug });
        mail.state.labels = mail.state.labels.filter(x => x.slug !== l.slug);
        mail.emit('labels');
        if (onDeleted) onDeleted();
        mail.clearLabelEverywhere(l.slug).then(() => mail.emit('list')).catch(() => {});
        toast(t('Label deleted'));
      } catch (e) { toast(e.message, false); }
    } }
  ];
}

/** Reader menu: tick labels on/off for these messages. */
export function applyMenu(emails, done) {
  const has = slug => emails.some(e => e.keywords && e.keywords['label:' + slug]);
  return [
    { title: t('Label as') },
    ...mail.state.labels.map(l => ({ label: l.name, dot: l.color, checked: has(l.slug), run: async () => {
      const on = !has(l.slug);
      try {
        await mail.setLabel(emails.map(e => e.id), l.slug, on);
        for (const e of emails) { e.keywords = { ...(e.keywords || {}) }; if (on) e.keywords['label:' + l.slug] = true; else delete e.keywords['label:' + l.slug]; }
        toast(on ? t('Labelled "{name}"', { name: l.name }) : t('Label "{name}" removed', { name: l.name }));
        if (done) done();
      } catch (e) { toast(e.message, false); }
    } })),
    { label: t('New label…'), icon: 'plus', run: async () => {
      const l = await promptNew();
      if (!l) return;
      try {
        await mail.setLabel(emails.map(e => e.id), l.slug, true);
        for (const e of emails) e.keywords = { ...(e.keywords || {}), ['label:' + l.slug]: true };
        if (done) done();
      } catch (e) { toast(e.message, false); }
    } }
  ];
}
