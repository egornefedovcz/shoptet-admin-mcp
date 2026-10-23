import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, isoToAdminDate, normalizeNewlines, asText, UNTRUSTED_NOTE, UserError } from '../src/util.js';

test('parseNumber handles Czech formatting', () => {
  assert.equal(parseNumber('1 990 Kč'), 1990);
  assert.equal(parseNumber('1 990,50'), 1990.5);
  assert.equal(parseNumber('0'), 0);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
});

test('isoToAdminDate converts and validates', () => {
  assert.equal(isoToAdminDate('2026-12-31'), '31.12.2026');
  assert.throws(() => isoToAdminDate('31.12.2026'), UserError);
});

test('normalizeNewlines', () => assert.equal(normalizeNewlines('a\r\nb'), 'a\nb'));

test('untrusted shop data is labelled', () => {
  assert.ok(asText({ a: 1 }, { untrusted: true }).content[0].text.startsWith(UNTRUSTED_NOTE));
  assert.ok(!asText({ a: 1 }).content[0].text.includes(UNTRUSTED_NOTE));
});
