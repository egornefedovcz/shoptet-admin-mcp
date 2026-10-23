# Playwright recipes for the Shoptet admin

Plain ES modules, Playwright ≥ 1.40. Every snippet was used against a real admin; the complete, tested versions live in `src/` of the shoptet-admin-mcp repo (`session.js`, `readers.js`, `writers.js`).
Credentials come from the environment. Never hard-code them.

## Session: login, throttle, no parallelism

```js
import { chromium } from 'playwright';
const { SHOPTET_URL, SHOPTET_EMAIL, SHOPTET_PASSWORD } = process.env;   // e.g. https://myshop.myshoptet.com
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await (await browser.newContext({ locale: 'cs-CZ', viewport: { width: 1440, height: 1000 } })).newPage();

// Floating onboarding iframe can cover buttons.
await page.addInitScript(() => {
  const add = () => { const s = document.createElement('style'); s.textContent = 'iframe[id^="userpilot"]{display:none!important}'; document.head.appendChild(s); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', add) : add();
});

let last = 0;
async function go(path, waitUntil = 'domcontentloaded') {
  const wait = last + 2500 + Math.random() * 500 - Date.now();       // serial + slow: the WAF punishes bursts
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const res = await page.goto(SHOPTET_URL + path, { waitUntil, timeout: 90000 });
  if (res && (res.status() === 403 || res.status() === 429)) throw new Error('Blocked by the firewall - stop and contact Shoptet support');
  return page;
}

await go('/admin/login/');
await page.fill('input[name=email]', SHOPTET_EMAIL);               // names, not localized placeholders
await page.fill('input[name=password]', SHOPTET_PASSWORD);
await Promise.all([page.waitForURL((u) => !u.pathname.includes('/login')), page.press('input[name=password]', 'Enter')]);
```

## Tables: wait for the batch rendering to finish, map by header

```js
async function readTable(columns /* { field: 'regex source' } */) {
  await page.locator('table tbody tr').first().waitFor({ timeout: 12000 }).catch(() => {});   // an empty filter has no rows
  let prev = -1;
  for (let i = 0; i < 20; i++) { await sleep(1000); const n = await page.locator('table tbody tr').count(); if (n === prev) break; prev = n; }
  return page.evaluate((columns) => {
    const heads = [...document.querySelectorAll('table th')].map((t) => t.innerText.trim());
    const idx = Object.fromEntries(Object.entries(columns).map(([f, src]) => [f, heads.findIndex((h) => new RegExp(src, 'i').test(h))]).filter(([, i]) => i >= 0));
    return [...document.querySelectorAll('table tbody tr')].map((tr) => {
      const td = [...tr.querySelectorAll('td')];
      // a cell with a <select> (order status) shows only the selected option
      const txt = (c) => (c.querySelector('select') ? c.querySelector('select').selectedOptions[0]?.text ?? '' : c.innerText).trim().replace(/\s+/g, ' ');
      return Object.fromEntries(Object.entries(idx).map(([f, i]) => [f, td[i] ? txt(td[i]) : '']));
    });
  }, columns);
}

await go('/admin/slevove-kupony/?f[code]=SUMMER');                 // filters are query parameters f[<column>]
const coupons = await readTable({ code: '^(Kód|Code)$', validUntil: '^(Platný do|Valid until)$' });
```

## Product price list (variants)

```js
await go(`/admin/produkty-detail/?id=${productId}`, 'commit');
await page.locator('a[href="#cenik"]').waitFor({ timeout: 90000 });
await page.waitForFunction(() => [...document.querySelectorAll('.loaderArea--screen')].every((e) => !e.checkVisibility()), null, { timeout: 60000 });
await page.locator('a[href="#cenik"]').click();
const cell = page.locator('[data-testid="tableCellVariantName"]');
await cell.first().waitFor({ timeout: 20000 });
let prev = -1; for (let i = 0; i < 30; i++) { await sleep(1200); const n = await cell.count(); if (n === prev) break; prev = n; }
const variants = await page.evaluate(() => [...document.querySelectorAll('tr')].filter((tr) => tr.querySelector('[data-testid="tableCellVariantName"]')).map((tr) => {
  const price = tr.querySelector('input[name^="price["]');
  return { id: price?.name.match(/\[(\d+)\]/)[1], name: tr.querySelector('[data-testid="tableCellVariantName"]').textContent.trim(),
    code: tr.querySelector('input[name^="variantCode["]')?.value, price: price?.value, stock: tr.querySelector('input[name^="variantStock["]')?.value };
}));
// Write: set price[id] / variantStock[id] inputs, then click the "Uložit" link (getByRole('link', { name: /^(Uložit|Uložiť|Save)$/i })), reload and re-read.
```

## Forms that you submit natively (CSRF)

```js
// 1) Get the token FIRST, from any page that has it (list pages do; coupon detail does not).
await go('/admin/slevove-kupony/');
const csrf = await page.evaluate(() => document.querySelector('input[name="__csrf__"]').value);

// 2) Open and fill the form.
await go('/admin/slevove-kupony-detail/', 'load');
await page.locator('input[name="code"]').fill('SUMMER10');
await page.locator('select[name="discountType"]').selectOption('percentual');   // or 'fixed'
await page.locator('input[name="discount"]').fill('10');
await page.locator('input[name="validUntil"]').fill('31.08.2026');              // dd.mm.yyyy

// 3) Submit with the hidden fields the buttons would add.
await Promise.all([
  page.waitForNavigation({ waitUntil: 'commit' }).catch(() => {}),
  page.evaluate((token) => {
    const f = document.querySelector('form:has(input[name="code"])');
    for (const [name, value] of [['buttonAction', 'add'], ['__csrf__', token]]) {
      const i = document.createElement('input'); i.type = 'hidden'; i.name = name; i.value = value; f.appendChild(i);
    }
    f.submit();
  }, csrf),
]);
// 4) Always re-read the list and compare.
```

## React textarea (banner content)

```js
await go('/admin/bannery-detail/banner2');
const ta = page.locator('textarea[name="content"]');
await ta.waitFor();
for (let i = 1; ; i++) {
  await sleep(1500 * i);
  await ta.fill(newHtml);                      // .value = … is ignored by React
  await sleep(800);
  if ((await ta.inputValue()) === newHtml) break;   // the form can re-render and drop the text
  if (i >= 3) throw new Error('editor keeps resetting');
}
await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('[data-testid="buttonSaveAndStay"]:visible').first().click()]);
```

## CodeMirror (HTML codes)

```js
await go('/admin/html-kody/');
await page.waitForFunction(() => [...document.querySelectorAll('.CodeMirror')].every((c) => c.CodeMirror), null, { timeout: 60000 });
const all = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.CodeMirror')].map((cm) => [cm.previousElementSibling.name, cm.CodeMirror.getValue()])));
await page.evaluate((v) => { for (const cm of document.querySelectorAll('.CodeMirror')) if (cm.previousElementSibling.name === 'footer') { cm.CodeMirror.setValue(v); cm.CodeMirror.save(); } }, newFooter);
```

## Rich-text (TinyMCE) fields: save without reformatting

```js
await page.evaluate(async () => {
  const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();     // raw server HTML
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (window.tinymce) tinymce.remove();
  doc.querySelectorAll('form#main-form textarea[name]').forEach((t) => { const mine = document.querySelector(`form#main-form textarea[name="${t.name}"]`); if (mine) mine.value = t.value; });
});
// …change only the fields you mean to change, save, reload, and compare every text field against the raw values.
```

## Safe write skeleton

```js
async function safeWrite({ read, expected, write, verify }) {
  const before = await read();
  if (before !== expected) throw new Error('Changed since you looked - not writing');
  await write();
  const after = await read();
  if (!verify(after)) throw new Error('Verification failed - revert with the saved "before" value');
  return { before, after };
}
// After any write that saves a big admin form (HTML codes!), close the browser and log in again before the next edit.
```
