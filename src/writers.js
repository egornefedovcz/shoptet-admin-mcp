import { sleep, fail, LABEL, parseNumber, isoToAdminDate, todayIso, normalizeNewlines } from './util.js';
import * as R from './readers.js';

/**
 * Guarded writes. Every kind has propose / apply / revert:
 *  - propose reads the current state and stores it as the "before" snapshot (nothing is changed);
 *  - apply re-reads, refuses if the state moved since the proposal, writes, then re-reads to verify;
 *  - revert restores the snapshot only if the shop is still in the state apply produced.
 * Nothing is ever deleted except a redirect that this tool created.
 */

const norm = normalizeNewlines;

// ---------- helpers ----------

/** Fetch the page's server-rendered HTML and return every form field (TinyMCE-independent). */
async function serverFields(page, { skip = /^(__csrf__|string|buttonAction)$|^(price|variantStock)\[/ } = {}) {
  return page.evaluate(async (skipSrc) => {
    const skip = new RegExp(skipSrc);
    const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = {};
    let i = 0;
    for (const e of doc.querySelectorAll('form#main-form input, form#main-form select, form#main-form textarea')) {
      if (!e.name || skip.test(e.name) || e.type === 'file' || e.type === 'submit') continue;
      const v = e.tagName === 'SELECT' ? (e.selectedOptions[0]?.value ?? '') : e.type === 'checkbox' || e.type === 'radio' ? (e.checked ? e.value : '') : e.value;
      out[`${e.name}#${i++}`] = v.replace(/\r\n/g, '\n');
    }
    return out;
  }, skip.source);
}

const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

function firstDiff(a, b) {
  const x = norm(a).split('\n'), y = norm(b).split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return { line: i + 1, before: x[i] ?? '(end)', after: y[i] ?? '(end)' };
}

const clip = (s, n = 160) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

// ---------- coupon ----------

const coupon = {
  async propose(s, p) {
    const code = p.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,16}$/.test(code)) fail('Coupon code: 3–16 characters, A–Z, 0–9 and hyphen only (Shoptet accepts at most 16).');
    if (/^-|-$|--/.test(code)) fail('Coupon code must not start or end with a hyphen or contain two in a row.');
    if (p.discountType === 'percent' && p.discount > 100) fail('Percent discount must be 1–100.');
    if (p.validUntil < todayIso()) fail('validUntil must be today or later.');
    if (p.validFrom && p.validFrom > p.validUntil) fail('validFrom is after validUntil.');
    const templates = await R.listCouponTemplates(s);
    const templateId = String(p.templateId ?? '1');
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) fail(`Unknown coupon template "${templateId}". Available: ${templates.map((t) => `${t.id}=${t.name}`).join(', ')}`);
    const { coupons } = await R.listCoupons(s, { code });
    if (coupons.some((c) => c.code === code)) fail(`Coupon ${code} already exists. Nothing to create.`);
    const plan = { code, discountType: p.discountType, discount: p.discount, validFrom: p.validFrom ?? null, validUntil: p.validUntil,
      minOrderAmount: p.minOrderAmount ?? null, singleUse: !!p.singleUse, templateId, templateName: tpl.name, note: p.note ?? '' };
    return {
      summary: `Create coupon ${code}: ${p.discount}${p.discountType === 'percent' ? ' %' : ' (currency of the shop)'} off, valid ${p.validFrom ? `from ${p.validFrom} ` : ''}until ${p.validUntil}, template "${tpl.name}"${plan.singleUse ? ', single use' : ', reusable'}${plan.minOrderAmount ? `, min order ${plan.minOrderAmount}` : ''}.`,
      plan, before: null,
      revertNote: 'Revert ends the coupon validity (sets "valid until" to yesterday). Coupons are never deleted.',
    };
  },

  async apply(s, d) {
    const p = d.plan;
    await s.csrf();   // before opening the form: fetching it later would navigate away from it
    const { coupons } = await R.listCoupons(s, { code: p.code });
    if (coupons.some((c) => c.code === p.code)) fail(`Coupon ${p.code} appeared since the proposal. Not creating a duplicate.`);
    const page = await s.go('/admin/slevove-kupony-detail/', { waitUntil: 'load' });
    await page.locator('input[name="code"]').waitFor({ timeout: 60000 });
    await sleep(1500);
    await page.locator('input[name="addMoreCoupons"][value="0"]').check();
    await page.locator('input[name="code"]').fill(p.code);
    await page.locator('select[name="discountType"]').selectOption(p.discountType === 'percent' ? 'percentual' : 'fixed');
    await page.locator('input[name="discount"]').fill(String(p.discount));
    await page.locator('select[name="templateId"]').selectOption(p.templateId);
    await page.locator('select[name="delivery"]').selectOption('1');
    if (p.validFrom) await page.locator('input[name="validFrom"]').fill(isoToAdminDate(p.validFrom));
    await page.locator('input[name="validUntil"]').fill(isoToAdminDate(p.validUntil));
    if (p.minOrderAmount) await page.locator('input[name="fromAmount"]').fill(String(p.minOrderAmount));
    if (p.note) await page.locator('textarea[name="remark"]').fill(p.note);
    const multi = page.locator('input[name="multipleUsability"]');
    if (p.singleUse) await multi.uncheck(); else await multi.check();
    await s.submitForm('form:has(input[name="code"])', 'add');
    await sleep(3000);
    const { coupons: after } = await R.listCoupons(s, { code: p.code });
    const row = after.find((c) => c.code === p.code);
    if (!row) fail('The coupon is not in the list after saving. Check the admin before retrying.');
    if (row.validUntil !== isoToAdminDate(p.validUntil)) fail(`Coupon created but valid until "${row.validUntil}" instead of ${isoToAdminDate(p.validUntil)}. Check it in the admin.`);
    return { message: `Coupon ${p.code} created and verified in the list.`, row };
  },

  async revert(s, d) {
    const p = d.plan;
    await s.csrf();
    const { coupons } = await R.listCoupons(s, { code: p.code });
    const row = coupons.find((c) => c.code === p.code);
    if (!row?.id) return { message: `Coupon ${p.code} does not exist; nothing to revert.` };
    const yesterday = isoToAdminDate(todayIso(-1));
    const page = await s.go(`/admin/slevove-kupony-detail/?id=${row.id}`, { waitUntil: 'load' });
    await page.locator('input[name="code"]').waitFor({ timeout: 60000 });
    await sleep(1500);
    if ((await page.locator('input[name="code"]').inputValue()) !== p.code) fail('Coupon detail does not match the expected code. Not touching it.');
    await page.locator('input[name="validUntil"]').fill(yesterday);
    await s.submitForm('form:has(input[name="code"])', 'saveAndStay');
    await sleep(3000);
    const { coupons: after } = await R.listCoupons(s, { code: p.code });
    const now = after.find((c) => c.code === p.code);
    if (now?.validUntil !== yesterday) fail(`After saving, the coupon is valid until "${now?.validUntil}" (expected ${yesterday}). End it manually in the admin.`);
    return { message: `Coupon ${p.code} no longer valid (ended ${yesterday}). It stays in the admin for order history.` };
  },
};

// ---------- redirect ----------

const redirect = {
  async propose(s, p) {
    const from = p.from.trim(), to = p.to.trim();
    if (!/^\/[^\s]*$/.test(from)) fail('"from" must be a path starting with "/", e.g. /old-page/');
    if (from === '/' || /^\/admin(\/|$)/.test(from)) fail('Redirecting "/" or /admin is not allowed.');
    if (!/^(\/[^\s]*|https?:\/\/[^\s]+)$/.test(to)) fail('"to" must be a path ("/new/") or an absolute http(s) URL.');
    if (from === to) fail('"from" and "to" are identical.');
    const { redirects } = await R.listRedirects(s, { from });
    const cur = redirects.filter((r) => r.from === from);
    if (cur.length) fail(`${from} is already redirected to ${cur.map((r) => r.to).join(', ')}. Remove that rule in the admin first.`);
    return { summary: `Add redirect ${from} → ${to}.`, plan: { from, to }, before: null, revertNote: 'Revert deletes exactly this rule.' };
  },

  async apply(s, d) {
    const { from, to } = d.plan;
    const { redirects } = await R.listRedirects(s, { from });
    if (redirects.some((r) => r.from === from)) fail(`${from} got a redirect since the proposal. Not adding another.`);
    const page = s.page;
    await page.getByRole('button', { name: LABEL.add }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor({ timeout: 30000 });
    await dlg.locator('input[name="fromUrl"]').fill(from);
    await dlg.locator('input[name="toUrl"]').fill(to);
    await dlg.getByRole('button', { name: LABEL.save }).click();
    await sleep(4000);
    const { redirects: after } = await R.listRedirects(s, { from });
    if (!after.some((r) => r.from === from && r.to === to)) fail('The rule is not in the list after saving. Check the admin.');
    return { message: `Redirect ${from} → ${to} added and verified.` };
  },

  async revert(s, d) {
    const { from, to } = d.plan;
    const { redirects } = await R.listRedirects(s, { from });
    if (!redirects.some((r) => r.from === from && r.to === to)) return { message: 'The rule does not exist; nothing to revert.' };
    const page = s.page;
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = page.locator('tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${esc}$`) }) }).filter({ hasText: to });
    const n = await row.count();
    if (n !== 1) fail(`The rule appears ${n}× in the list; not deleting automatically.`);
    await row.hover();
    await row.getByTitle(LABEL.remove).click();
    const dlg = page.getByRole('dialog').filter({ hasText: LABEL.remove });
    await dlg.waitFor({ timeout: 30000 });
    await dlg.getByRole('button', { name: LABEL.ok }).click();
    await sleep(4000);
    const { redirects: after } = await R.listRedirects(s, { from });
    if (after.some((r) => r.from === from && r.to === to)) fail('The rule is still listed after deleting. Remove it in the admin.');
    return { message: `Redirect ${from} → ${to} removed.` };
  },
};

// ---------- variant price / stock ----------

const variant = {
  async propose(s, p) {
    if (p.price == null && p.stock == null) fail('Give at least one of price or stock.');
    const code = p.code.trim();
    const { productName, variants } = await R.readVariants(s, p.productId);
    const hit = variants.filter((v) => v.code === code);
    if (hit.length !== 1) fail(`Variant code "${code}" found ${hit.length}× in product ${p.productId}; need exactly one.`);
    const v = hit[0];
    const before = { id: v.id, price: parseNumber(v.price), stock: parseNumber(v.stock) };
    const plan = { productId: p.productId, code, price: p.price ?? null, stock: p.stock ?? null };
    const parts = [];
    if (plan.price != null) parts.push(`price ${before.price} → ${plan.price}`);
    if (plan.stock != null) parts.push(`stock ${before.stock} → ${plan.stock}`);
    return { summary: `Product ${p.productId} "${productName}", variant ${code}: ${parts.join(', ')}.`, plan, before,
      revertNote: 'Revert restores the old values if nobody changed them since.' };
  },

  async write(s, productId, code, expect, next) {
    const { variants } = await R.readVariants(s, productId);
    const hit = variants.filter((v) => v.code === code);
    if (hit.length !== 1) fail(`Variant ${code} found ${hit.length}×; not touching it.`);
    const cur = { price: parseNumber(hit[0].price), stock: parseNumber(hit[0].stock) };
    if (cur.price !== expect.price || cur.stock !== expect.stock) fail(`Variant ${code} changed since the proposal (now price ${cur.price}, stock ${cur.stock}). Propose again.`);
    const page = s.page;
    const fieldsBefore = await serverFields(page);
    // Saving the price list submits the whole product form. Put the server's raw HTML back into the
    // rich-text fields first, so TinyMCE's re-formatting cannot silently rewrite descriptions.
    await page.evaluate(async () => {
      const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (window.tinymce) tinymce.remove();
      doc.querySelectorAll('form#main-form textarea[name]').forEach((t) => { const mine = document.querySelector(`form#main-form textarea[name="${t.name}"]`); if (mine) mine.value = t.value; });
    });
    const set = await page.evaluate(({ id, next }) => {
      let n = 0;
      const put = (name, v) => { const el = document.querySelector(`input[name="${name}[${id}]"]`); if (el) { el.value = String(v); n++; } };
      if (next.price != null) put('price', next.price);
      if (next.stock != null) put('variantStock', next.stock);
      return n;
    }, { id: hit[0].id, next });
    const want = (next.price != null) + (next.stock != null);
    if (set !== want) fail(`Price list has ${set} of ${want} expected fields. Nothing saved.`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'commit', timeout: 90000 }),
      page.getByRole('link', { name: LABEL.save }).first().click(),
    ]);
    await page.locator('a[href="#cenik"]').waitFor({ timeout: 60000 });
    const { variants: after } = await R.readVariants(s, productId);
    const now = after.find((v) => v.id === hit[0].id);
    const problems = [];
    if (!now) problems.push('variant missing after saving');
    else {
      if (next.price != null && parseNumber(now.price) !== next.price) problems.push(`price is ${now.price}, expected ${next.price}`);
      if (next.stock != null && parseNumber(now.stock) !== next.stock) problems.push(`stock is ${now.stock}, expected ${next.stock}`);
    }
    const changed = diffKeys(fieldsBefore, await serverFields(page));
    if (changed.length) problems.push(`other product fields changed: ${changed.slice(0, 6).join(', ')}`);
    if (problems.length) fail(`Saved, but verification failed: ${problems.join('; ')}. Use revert_change or fix in the admin.`);
    return now;
  },

  async apply(s, d) {
    const { plan: p, before } = d;
    const next = { price: p.price, stock: p.stock };
    const now = await this.write(s, p.productId, p.code, { price: before.price, stock: before.stock }, next);
    return { message: `Variant ${p.code} updated and verified (price ${now.price}, stock ${now.stock}).` };
  },

  async revert(s, d) {
    const { plan: p, before } = d;
    const { variants } = await R.readVariants(s, p.productId);
    const v = variants.find((x) => x.code === p.code);
    if (!v) fail(`Variant ${p.code} not found.`);
    const cur = { price: parseNumber(v.price), stock: parseNumber(v.stock) };
    if (cur.price === before.price && cur.stock === before.stock) return { message: 'Values are already the original ones; nothing to revert.' };
    const applied = { price: p.price ?? before.price, stock: p.stock ?? before.stock };
    if (cur.price !== applied.price || cur.stock !== applied.stock) fail(`Variant ${p.code} changed after the update (price ${cur.price}, stock ${cur.stock}); not reverting over someone else's change.`);
    await this.write(s, p.productId, p.code, applied, { price: before.price, stock: before.stock });
    return { message: `Variant ${p.code} restored (price ${before.price}, stock ${before.stock}).` };
  },
};

// ---------- text fields: HTML codes and banners ----------

/** Shared logic for "replace one text field, verify, keep the rest untouched". */
function textField({ read, write, label }) {
  return {
    async propose(s, p) {
      const cur = await read(s, p);
      const next = norm(p.newValue);
      if (norm(cur.value) === next) fail(`${label(p)} already has this content.`);
      const d = firstDiff(cur.value, next);
      return {
        summary: `Replace ${label(p)}: ${norm(cur.value).length} → ${next.length} characters. First difference at line ${d.line}: "${clip(d.before)}" → "${clip(d.after)}".`,
        plan: { ...p, newValue: next }, before: { value: norm(cur.value) },
        revertNote: 'Revert writes the previous content back if nobody changed it since.',
      };
    },
    async apply(s, d) {
      const cur = await read(s, d.plan);
      if (norm(cur.value) !== d.before.value) fail(`${label(d.plan)} changed since the proposal. Propose again.`);
      await write(s, d.plan, cur, d.plan.newValue);
      return { message: `${label(d.plan)} saved and verified; other fields unchanged.` };
    },
    async revert(s, d) {
      const cur = await read(s, d.plan);
      if (norm(cur.value) === d.before.value) return { message: 'Content is already the original; nothing to revert.' };
      if (norm(cur.value) !== norm(d.plan.newValue)) fail(`${label(d.plan)} changed after the update; not reverting over someone else's change.`);
      await write(s, d.plan, cur, d.before.value);
      return { message: `${label(d.plan)} restored.` };
    },
  };
}

const SAVE_AND_STAY = '[data-testid="buttonSaveAndStay"]:visible';

/**
 * Click "Save and stay" and wait for the page to reload. The admin's loading overlay sits on <body> and
 * swallows clicks, so wait it out first. Occasionally the button stays "covered" by the page even though
 * nothing is on top of it; then fall back to dispatching the click event on the same button.
 */
async function clickSaveAndStay(s) {
  await s.waitForOverlays();
  const btn = s.page.locator(SAVE_AND_STAY).first();
  const navigated = s.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 });
  try { await btn.click({ timeout: 10000 }); }
  catch { await btn.dispatchEvent('click'); }
  await navigated;
}

const htmlCode = textField({
  label: (p) => `HTML code "${p.field}"`,
  async read(s, p) { const all = await R.readHtmlCodes(s); if (!(p.field in all)) fail(`No HTML code field "${p.field}". Fields: ${Object.keys(all).filter((k) => !k.startsWith('select:')).join(', ')}`); return { value: all[p.field], all }; },
  async write(s, p, cur, value) {
    const page = s.page;
    await page.evaluate(({ field, value }) => {
      for (const cm of document.querySelectorAll('.CodeMirror')) {
        if (cm.previousElementSibling.name === field) { cm.CodeMirror.setValue(value); cm.CodeMirror.save(); }
      }
    }, { field: p.field, value });
    await clickSaveAndStay(s);
    const after = await R.readHtmlCodes(s);
    const problems = [];
    if (norm(after[p.field]) !== norm(value)) problems.push(`"${p.field}" was not saved exactly`);
    for (const k of Object.keys(cur.all)) if (k !== p.field && norm(after[k]) !== norm(cur.all[k])) problems.push(`field ${k} changed too`);
    if (problems.length) fail(`Saved, but verification failed: ${problems.join('; ')}. Use revert_change or fix in the admin.`);
  },
});

const banner = textField({
  label: (p) => `Banner ${p.bannerId}`,
  async read(s, p) { if (!/^[A-Za-z0-9_-]+$/.test(p.bannerId)) fail('Invalid banner id.'); const b = await R.getBanner(s, { id: p.bannerId }); return { value: b.content, other: b.other }; },
  async write(s, p, cur, value) {
    const page = s.page;
    // The field is a React-controlled textarea: setting .value is ignored, it has to be filled like a user would.
    // The form can also re-render once more after load and silently drop what was typed, so fill,
    // confirm the value survived, and only then save.
    const ta = page.locator('textarea[name="content"]');
    for (let i = 1; ; i++) {
      await sleep(1500 * i);
      await ta.fill(value);
      await sleep(800);
      if (norm(await ta.inputValue()) === norm(value)) break;
      if (i >= 3) fail('The banner editor keeps resetting the text field; nothing was saved.');
    }
    await clickSaveAndStay(s);
    const after = await R.getBanner(s, { id: p.bannerId });
    const problems = [];
    if (norm(after.content) !== norm(value)) problems.push('content was not saved exactly');
    if (JSON.stringify(after.other) !== JSON.stringify(cur.other)) problems.push('other banner settings changed');
    if (problems.length) fail(`Saved, but verification failed: ${problems.join('; ')}. Use revert_change or fix in the admin.`);
  },
});

export const HANDLERS = { coupon, redirect, variant, html_code: htmlCode, banner };
