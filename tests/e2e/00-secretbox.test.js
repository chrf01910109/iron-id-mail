// Unit checks for the encryption of stored secrets.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'unit-test-token';
const box = require('../../webmail/services/secretBox');

test('round trip works only in the same context', () => {
  const sealed = box.encrypt('Basic dXNlcjpwYXNz', 'session:abc');
  assert.equal(box.decrypt(sealed, 'session:abc'), 'Basic dXNlcjpwYXNz');
  assert.throws(() => box.decrypt(sealed, 'session:other'), 'copied into another row it cannot be read');
});

test('tampered or truncated values are rejected', () => {
  const sealed = box.encrypt('secret', 'ctx');
  const [v, iv, tag, data] = sealed.split('.');
  const flip = data.slice(0, -2) + (data.slice(-2) === 'AA' ? 'AB' : 'AA');
  assert.throws(() => box.decrypt([v, iv, tag, flip].join('.'), 'ctx'));
  assert.throws(() => box.decrypt([v, iv, tag.slice(0, 8), data].join('.'), 'ctx'), 'short tag');
  assert.throws(() => box.decrypt('v1.x.y.z', 'ctx'), 'old format');
});

test('each encryption uses a fresh IV', () => {
  assert.notEqual(box.encrypt('same', 'ctx'), box.encrypt('same', 'ctx'));
});
