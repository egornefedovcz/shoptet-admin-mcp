import { sleep, fail, parseNumber } from './util.js';

/**
 * Read-only extractors. Each takes a Session `s` (already inside `s.exclusive`).
 * Tables are mapped by header text (cs/sk/en), not by column position.
 */

const COLUMNS = {
  products: { name: '^(Název|Názov|Name)$', price: '^(Cena|Price)$', visibility: '^(Viditelnost|Viditeľnosť|Visibility)$' },
  coupons: {
    code: '^(Kód|Code)$', created: '^(Vytvořeno|Vytvorené|Created)$', discount: '^(Sleva|Zľava|Discount)$',
    template: '^(Šablona|Šablóna|Template)$', usability: '^(Použitelnost|Použiteľnosť|Usability)$',
    used: '^(Použito|Použité|Used)$', validFrom: '^(Platný od|Valid from)$', validUntil: '^(Platný do|Valid until)$',
    minAmount: '^(Od částky|Od sumy|From amount)$',
  },
  redirects: { from: '^(Z adresy|From)', to: '^(Na adresu|To)', auto: '^(Automaticky|Automatic)' },
  banners: { name: '^(Název|Názov|Name)$', from: '^(Zobrazit od|Zobraziť od|Show from)$', to: '^(Zobrazit do|Zobraziť do|Show until)$', visibility: '^(Viditelnost|Viditeľnosť|Visibility)$', position: '^(Pozice|Pozícia|Position)$' },
  // Customer name, e-mail and address are deliberately NOT mapped: orders are returned without personal data.
  orders: { codeAndDate: '^(Kód a datum|Kód a dátum|Code and date)', shipping: '^(Způsob dopravy|Spôsob dopravy|Shipping)', payment: '^(Platba|Payment)$', status: '^(Stav|Status)$', total: '^(Cena|Price|Total)', channel: '^(Prodejní kanál|Predajný kanál|Sales channel)' },
};

/**
 * Wait until a table has rows and its row count stops growing (the admin renders in batches).
 * A filter with no matches legitimately yields zero rows, so the first-row wait is short.
 */
async function waitForTable(page) {
  await page.locator('table tbody tr').first().waitFor({ timeout: 12000 }).catch(() => {});
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const n = await page.locator('table tbody tr').count();
    if (n === prev) break;
    prev = n;
  }
  return prev;
}

async function readTable(page, columns, hrefPattern, firstLine = []) {
  return page.evaluate(({ columns, hrefPattern, firstLine }) => {
    const heads = [...document.querySelectorAll('table th')].map((t) => t.innerText.trim());
    const idx = {};
    for (const [field, src] of Object.entries(columns)) {
      const i = heads.findIndex((h) => new RegExp(src, 'i').test(h));
      if (i >= 0) idx[field] = i;
    }
    return [...document.querySelectorAll('table tbody tr')].map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      if (!tds.length) return null;
      // A cell with a <select> (e.g. order status) shows only the selected option, not the whole menu.
      const text = (c) => (c.querySelector('select') ? c.querySelector('select').selectedOptions[0]?.text ?? '' : c.innerText).trim().replace(/\s+/g, ' ');
      const row = {};
      for (const [field, i] of Object.entries(idx)) {
        const c = tds[i];
        row[field] = !c ? '' : firstLine.includes(field) ? c.innerText.split('\n')[0].trim() : text(c);
      }
      if (hrefPattern) {
        const href = [...tr.querySelectorAll('a')].map((a) => a.getAttribute('href') || '').find((h) => new RegExp(hrefPattern).test(h));
        const m = href && href.match(new RegExp(hrefPattern));
        if (m) row.id = m[1];
      }
      return row;
    }).filter(Boolean);
  }, { columns, hrefPattern, firstLine });
}

export async function shopInfo(s) {
  const page = await s.go('/admin/');
  return { host: s.cfg.host, adminTitle: await page.title(), writeEnabled: s.cfg.allowWrite };
}

export async function listProducts(s, { query, limit = 50 }) {
  const page = await s.go('/admin/produkty/');
  await waitForTable(page);
  let rows = await readTable(page, COLUMNS.products, 'produkty-detail/\\?id=(\\d+)', ['name']);
  rows = rows.filter((r) => r.id);
  if (query) {
    const q = query.toLowerCase();
    rows = rows.filter((r) => String(r.name ?? '').toLowerCase().includes(q));
  }
  return { shown: Math.min(rows.length, limit), matched: rows.length, products: rows.slice(0, limit) };
}

async function openProduct(s, id) {
  const page = await s.go(`/admin/produkty-detail/?id=${id}`, { waitUntil: 'commit' });
  await page.locator('form#main-form textarea[name="description"]').waitFor({ state: 'attached', timeout: 90000 });
  await s.waitForOverlays();
  await sleep(1500);
  await page.waitForFunction(() => !window.tinymce || tinymce.editors.every((e) => e.initialized), null, { timeout: 20000 }).catch(() => {});
  if (!page.url().includes(`produkty-detail/?id=${id}`)) fail(`Product ${id} did not open (${page.url()})`);
  return page;
}

export async function getProduct(s, { id, maxChars = 4000 }) {
  const page = await openProduct(s, id);
  const p = await page.evaluate(() => {
    if (window.tinymce) tinymce.triggerSave();
    const f = document.querySelector('form#main-form');
    const val = (n) => f.elements[n]?.value ?? null;
    const vis = f.elements['visibility'];
    return {
      name: val('name'), shortDescription: val('shortDescription'), description: val('description'),
      visibility: vis?.value ?? null,
      visibilityOptions: vis ? Object.fromEntries([...vis.options].map((o) => [o.value, o.text.trim()])) : null,
    };
  });
  const cut = (t) => (t && t.length > maxChars ? t.slice(0, maxChars) + `… [truncated, ${t.length} chars total]` : t);
  return { id: Number(id), ...p, shortDescription: cut(p.shortDescription), description: cut(p.description) };
}

/** Variants of a product from the price list tab: id, name, code, price, stock. */
export async function readVariants(s, productId) {
  const page = await openProduct(s, productId);
  const name = await page.locator('form#main-form [name=name]').inputValue().catch(() => null);
  await page.locator('a[href="#cenik"]').click();
  const cell = page.locator('[data-testid="tableCellVariantName"]');
  await cell.first().waitFor({ timeout: 20000 }).catch(() => {});
  // The table renders in batches: wait until the row count stops growing.
  let prev = -1;
  for (let i = 0; i < 30; i++) {
    await sleep(1200);
    const n = await cell.count();
    if (n === prev) break;
    prev = n;
  }
  const rows = await page.evaluate(() => [...document.querySelectorAll('tr')]
    .filter((tr) => tr.querySelector('[data-testid="tableCellVariantName"]'))
    .map((tr) => {
      const price = tr.querySelector('input[name^="price["]');
      return {
        id: price ? price.name.match(/\[(\d+)\]/)[1] : null,
        name: tr.querySelector('[data-testid="tableCellVariantName"]').textContent.trim(),
        code: tr.querySelector('input[name^="variantCode["]')?.value ?? '',
        price: price?.value ?? '',
        stock: tr.querySelector('input[name^="variantStock["]')?.value ?? '',
      };
    }));
  if (rows.length !== prev) fail(`Product ${productId}: read ${rows.length} variant rows but the table has ${prev}. Try again.`);
  return { productName: name, variants: rows };
}

export async function listCoupons(s, { code }) {
  const q = code ? `?f[code]=${encodeURIComponent(code)}` : '';
  const page = await s.go(`/admin/slevove-kupony/${q}`);
  await waitForTable(page);
  const rows = await readTable(page, COLUMNS.coupons, 'slevove-kupony-detail/\\?id=(\\d+)');
  return { coupons: rows.filter((r) => r.code) };
}

export async function listCouponTemplates(s) {
  const page = await s.go('/admin/slevove-kupony-detail/', { waitUntil: 'load' });
  await page.locator('select[name="templateId"]').waitFor({ timeout: 60000 });
  return page.evaluate(() => [...document.querySelector('select[name="templateId"]').options].map((o) => ({ id: o.value, name: o.text.trim() })));
}

export async function listRedirects(s, { from } = {}) {
  const q = from ? `?f[fromUrl]=${encodeURIComponent(from)}` : '';
  const page = await s.go(`/admin/presmerovani-url/${q}`);
  await page.locator('button').first().waitFor({ timeout: 60000 });
  await waitForTable(page);
  const rows = await readTable(page, COLUMNS.redirects);
  return { redirects: rows.filter((r) => String(r.from ?? '').startsWith('/')) };
}

export async function listBanners(s) {
  const page = await s.go('/admin/bannery/');
  await waitForTable(page);
  const rows = await readTable(page, COLUMNS.banners, 'bannery-detail/([A-Za-z0-9_-]+)');
  return { banners: rows };
}

export async function getBanner(s, { id }) {
  const page = await s.go(`/admin/bannery-detail/${id}`);
  await page.locator('textarea[name="content"]').waitFor({ timeout: 60000 });
  await s.waitForOverlays();
  await sleep(1000);
  return page.evaluate(() => ({
    content: document.querySelector('textarea[name="content"]').value,
    other: Object.fromEntries([...document.querySelectorAll('form input, form select')]
      .filter((e) => e.name && e.type !== 'hidden' && e.name !== '__csrf__')
      .map((e) => [e.name, e.type === 'checkbox' ? e.checked : e.value])),
  }));
}

/** All CodeMirror-backed HTML code fields (header, footer, orderFinale, …) plus plain selects. */
export async function readHtmlCodes(s) {
  const page = await s.go('/admin/html-kody/');
  await page.waitForFunction(
    () => document.querySelectorAll('.CodeMirror').length >= 1 && [...document.querySelectorAll('.CodeMirror')].every((c) => c.CodeMirror),
    null, { timeout: 60000 },
  );
  return page.evaluate(() => {
    const out = {};
    for (const cm of document.querySelectorAll('.CodeMirror')) out[cm.previousElementSibling.name] = cm.CodeMirror.getValue();
    for (const sel of document.querySelectorAll('#main-form select')) out['select:' + sel.name] = sel.value;
    return out;
  });
}

export async function listOrders(s, { limit = 30 }) {
  const page = await s.go('/admin/prehled-objednavek/');
  await waitForTable(page);
  let rows = await readTable(page, COLUMNS.orders, 'objednavky-detail/\\?id=(\\d+)');
  rows = rows.filter((r) => r.id).map((r) => {
    const [code, ...date] = String(r.codeAndDate ?? '').split(' ');
    const { codeAndDate, ...rest } = r;
    return { ...rest, code, date: date.join(' '), totalNumber: parseNumber(r.total) };
  });
  return { shown: Math.min(rows.length, limit), orders: rows.slice(0, limit), note: 'Customer names, e-mails and addresses are intentionally not returned.' };
}

