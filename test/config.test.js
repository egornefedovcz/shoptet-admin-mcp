import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const ok = { SHOPTET_URL: 'https://demo.myshoptet.com', SHOPTET_EMAIL: 'a@example.com', SHOPTET_PASSWORD: 'x' };

test('accepts a bare https origin and defaults to read-only', () => {
  const c = loadConfig(ok);
  assert.equal(c.origin, 'https://demo.myshoptet.com');
  assert.equal(c.allowWrite, false);
  assert.ok(c.minDelayMs >= 1000);
});

test('strips a trailing slash', () => {
  assert.equal(loadConfig({ ...ok, SHOPTET_URL: 'https://demo.myshoptet.com/' }).origin, 'https://demo.myshoptet.com');
});

for (const [name, url] of [['http', 'http://demo.myshoptet.com'], ['a path', 'https://demo.myshoptet.com/admin'], ['a query', 'https://demo.myshoptet.com/?x=1'], ['garbage', 'not a url']]) {
  test(`rejects SHOPTET_URL with ${name}`, () => assert.throws(() => loadConfig({ ...ok, SHOPTET_URL: url })));
}

test('requires credentials', () => {
  assert.throws(() => loadConfig({ SHOPTET_URL: ok.SHOPTET_URL }), /SHOPTET_EMAIL/);
});

test('write is enabled only by an explicit truthy value', () => {
  assert.equal(loadConfig({ ...ok, SHOPTET_ALLOW_WRITE: '1' }).allowWrite, true);
  assert.equal(loadConfig({ ...ok, SHOPTET_ALLOW_WRITE: 'true' }).allowWrite, true);
  assert.equal(loadConfig({ ...ok, SHOPTET_ALLOW_WRITE: '0' }).allowWrite, false);
  assert.equal(loadConfig({ ...ok, SHOPTET_ALLOW_WRITE: 'maybe' }).allowWrite, false);
});

test('request delay cannot be configured below one second', () => {
  assert.equal(loadConfig({ ...ok, SHOPTET_MIN_DELAY_MS: '10' }).minDelayMs, 1000);
});
