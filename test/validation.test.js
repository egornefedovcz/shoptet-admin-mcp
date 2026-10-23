import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDLERS } from '../src/writers.js';

// These checks run before any page is opened, so no browser is needed.
const never = new Proxy({}, { get() { throw new Error('browser must not be used for invalid input'); } });
const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
const past = '2020-01-01';

const coupon = (over) => HANDLERS.coupon.propose(never, { code: 'SAVE10', discountType: 'percent', discount: 10, validUntil: future, ...over });

test('coupon: rejects bad codes', async () => {
  for (const code of ['ab', 'WAY-TOO-LONG-CODE-123', 'bad code', '-LEAD', 'TRAIL-', 'A--B', 'ČÁRKA']) {
    await assert.rejects(coupon({ code }), undefined, code);
  }
});
test('coupon: percent discount over 100 is rejected', () => assert.rejects(coupon({ discount: 101 }), /1–100/));
test('coupon: end date in the past is rejected', () => assert.rejects(coupon({ validUntil: past }), /today or later/));
test('coupon: start after end is rejected', () => assert.rejects(coupon({ validFrom: '2099-01-01' }), /after validUntil/));

const redirect = (from, to) => HANDLERS.redirect.propose(never, { from, to });
test('redirect: refuses "/" and /admin as source', async () => {
  await assert.rejects(redirect('/', '/x/'), /not allowed/);
  await assert.rejects(redirect('/admin/', '/x/'), /not allowed/);
  await assert.rejects(redirect('/admin/produkty/', '/x/'), /not allowed/);
});
test('redirect: source must be a path, target a path or http(s) URL', async () => {
  await assert.rejects(redirect('old', '/new/'), /starting with/);
  await assert.rejects(redirect('/old/', 'javascript:alert(1)'), /absolute http/);
  await assert.rejects(redirect('/same/', '/same/'), /identical/);
});

test('variant: needs price or stock', () => assert.rejects(HANDLERS.variant.propose(never, { productId: 1, code: 'X' }), /price or stock/));
