// Builds templates/<name>.json: one OpenSearch index template per engine index
// (st_email, st_calendar, st_contact, st_tracing).
//
// Each template does two things:
//  1. Repeats the engine's own index layout (engine-indexes-v0.16.23.json, captured from
//     the indexes Stalwart v0.16.23 creates). If the engine was started while OpenSearch
//     was down it never creates its indexes; OpenSearch then creates them on the first
//     write, and without this layout it would guess field types and keep a full copy of
//     every message (the engine turns that copy off).
//  2. Makes search ignore accents (réunion = reunion), French elisions
//     (l'équipe = équipe) and Arabic spelling variants (أ/إ/آ = ا, ة = ه, ى = ي, vowel
//     marks, tatweel). Index settings are merged key by key with matching templates, so
//     the char_filters below are added to the engine's "default" analyzer even when the
//     engine creates the index itself with its own analyzer.
//
// Run: node make-template.js   (writes templates/*.json next to it)
// After an engine upgrade, re-capture engine-indexes-*.json and re-run.
const fs = require('fs');
const path = require('path');

const ENGINE_INDEXES = 'engine-indexes-v0.16.23.json';
const engine = JSON.parse(fs.readFileSync(path.join(__dirname, ENGINE_INDEXES), 'utf8'));

const fold = {};
for (let cp = 0xc0; cp <= 0x24f; cp++) {
  const ch = String.fromCodePoint(cp);
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (base !== ch && /^[A-Za-z]+$/.test(base)) fold[ch] = base;
}
Object.assign(fold, {
  'Æ': 'AE', 'æ': 'ae', 'Œ': 'OE', 'œ': 'oe', 'ß': 'ss', 'Ø': 'O', 'ø': 'o',
  'Đ': 'D', 'đ': 'd', 'Ł': 'L', 'ł': 'l',
  '’': "'"                      // typographic apostrophe -> plain, so elision works
});
Object.assign(fold, { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ة': 'ه', 'ى': 'ي', 'ـ': '' });
for (let cp = 0x064b; cp <= 0x0652; cp++) fold[String.fromCodePoint(cp)] = '';   // Arabic vowel marks

const charFilters = {
  ironid_fold: { type: 'mapping', mappings: Object.entries(fold).map(([k, v]) => `${k}=>${v}`) },
  ironid_elision: {
    type: 'pattern_replace',
    pattern: "(?i)\\b(?:l|m|t|n|s|j|d|c|qu|jusqu|lorsqu|puisqu|quoiqu)'(?=\\p{L})",
    replacement: ''
  }
};

const templates = {};
for (const [index, def] of Object.entries(engine)) {
  const analysis = JSON.parse(JSON.stringify(def.analysis));
  if (!analysis.analyzer || !analysis.analyzer.default) throw new Error(`${index}: engine analyzer "default" not found`);
  analysis.analyzer.default.char_filter = Object.keys(charFilters);
  analysis.char_filter = charFilters;
  templates[`ironid-${index.replace(/_/g, '-')}`] = {
    index_patterns: [index],
    priority: 100,
    _meta: { owner: 'iron-id', source: ENGINE_INDEXES, purpose: 'engine index layout + accent/elision/Arabic-insensitive search' },
    template: {
      settings: { 'index.number_of_shards': 1, 'index.number_of_replicas': 0, analysis },
      mappings: def.mappings
    }
  };
}

const dir = path.join(__dirname, 'templates');
fs.mkdirSync(dir, { recursive: true });
for (const [name, t] of Object.entries(templates)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(t, null, 1) + '\n');
console.log(`wrote templates/: ${Object.keys(templates).join(', ')} (${Object.keys(fold).length} folding rules)`);
