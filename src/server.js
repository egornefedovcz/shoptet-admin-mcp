#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Session } from './session.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import * as R from './readers.js';
import { asText, asError, UserError } from './util.js';

let cfg;
try { cfg = loadConfig(); } catch (e) { console.error(`shoptet-admin-mcp: ${e.message}`); process.exit(1); }

const session = new Session(cfg);
const server = new McpServer({ name: 'shoptet-admin-mcp', version: '0.1.0' });

// stdout is the MCP channel: log to stderr only.
const log = (...a) => console.error('[shoptet-admin-mcp]', ...a);

/** Wrap a handler: serialize browser access, turn errors into tool errors, never leak the password. */
const run = (fn, { untrusted = false } = {}) => async (args) => {
  try { return asText(await fn(args), { untrusted }); }
  catch (e) {
    const msg = String(e.message ?? e).split(cfg.password).join('***');
    if (!(e instanceof UserError)) log('error:', msg);
    return asError(msg);
  }
};
const read = (fn, opts) => run((a) => session.exclusive((s) => fn(s, a)), opts);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const PROPOSE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const CHANGE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ---------- read tools (always available) ----------

server.registerTool('shoptet_shop_info', {
  title: 'Shop info', annotations: READ,
  description: 'Log in and confirm which shop this server is connected to, and whether write tools are enabled.',
  inputSchema: {},
}, read(R.shopInfo));

server.registerTool('shoptet_list_products', {
  title: 'List products', annotations: READ,
  description: 'List products from the admin product list (id, name, price text). Optional case-insensitive name filter.',
  inputSchema: { query: z.string().max(100).optional(), limit: z.number().int().min(1).max(200).optional() },
}, read(R.listProducts, { untrusted: true }));

server.registerTool('shoptet_get_product', {
  title: 'Get product', annotations: READ,
  description: 'Name, visibility, short description and description of one product. Long texts are truncated to max_chars.',
  inputSchema: { id: z.number().int().positive(), max_chars: z.number().int().min(200).max(50000).optional() },
}, read((s, a) => R.getProduct(s, { id: a.id, maxChars: a.max_chars }), { untrusted: true }));

server.registerTool('shoptet_get_price_list', {
  title: 'Product price list (variants)', annotations: READ,
  description: 'All variants of a product from its price list tab: variant id, name, code, price and stock.',
  inputSchema: { product_id: z.number().int().positive() },
}, read((s, a) => R.readVariants(s, a.product_id), { untrusted: true }));

server.registerTool('shoptet_list_coupons', {
  title: 'List discount coupons', annotations: READ,
  description: 'Discount coupons (code, discount, template, validity, usage). Optionally filter by code.',
  inputSchema: { code: z.string().max(40).optional() },
}, read(R.listCoupons));

server.registerTool('shoptet_list_coupon_templates', {
  title: 'List coupon templates', annotations: READ,
  description: 'Coupon templates you can pass as template_id when proposing a coupon.',
  inputSchema: {},
}, read(R.listCouponTemplates));

server.registerTool('shoptet_list_redirects', {
  title: 'List URL redirects', annotations: READ,
  description: 'URL redirect rules (from, to). Optionally filter by source path.',
  inputSchema: { from: z.string().max(300).optional() },
}, read(R.listRedirects));

server.registerTool('shoptet_list_banners', {
  title: 'List banners', annotations: READ,
  description: 'Banners (id like "banner2", name, position).',
  inputSchema: {},
}, read(R.listBanners, { untrusted: true }));

server.registerTool('shoptet_get_banner', {
  title: 'Get banner', annotations: READ,
  description: 'HTML content and settings of one banner.',
  inputSchema: { id: z.string().regex(/^[A-Za-z0-9_-]+$/) },
}, read(R.getBanner, { untrusted: true }));

server.registerTool('shoptet_get_html_codes', {
  title: 'Get HTML codes', annotations: READ,
  description: 'Custom HTML code fields from Appearance → Editor → HTML code (header, footer, orderFinale, robotsFile, llmsFile). Omit field to get all.',
  inputSchema: { field: z.string().regex(/^[A-Za-z]+$/).optional() },
}, read(async (s, a) => {
  const all = await R.readHtmlCodes(s);
  return a.field ? { [a.field]: all[a.field] ?? null } : all;
}, { untrusted: true }));

server.registerTool('shoptet_list_orders', {
  title: 'List orders (no personal data)', annotations: READ,
  description: 'Recent orders: id, code, date, status, total, shipping, payment, sales channel. Customer names, e-mails and addresses are never returned.',
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
}, read(R.listOrders));

// ---------- write tools (registered only with SHOPTET_ALLOW_WRITE=1) ----------

if (cfg.allowWrite) {
  const store = new Store(cfg);
  const engine = new Engine(session, store, cfg);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

  server.registerTool('shoptet_propose_coupon', {
    title: 'Propose: create coupon', annotations: PROPOSE,
    description: 'Prepare a new discount coupon. Changes nothing in the shop; returns a draft to confirm. Code: 3–16 chars A–Z, 0–9, hyphen. An end date is mandatory.',
    inputSchema: {
      code: z.string().min(3).max(16), discount_type: z.enum(['percent', 'amount']), discount: z.number().int().min(1),
      valid_until: date, valid_from: date.optional(), min_order_amount: z.number().int().min(1).optional(),
      single_use: z.boolean().optional(), template_id: z.string().max(10).optional(), note: z.string().max(300).optional(),
    },
  }, run((a) => engine.propose('coupon', { code: a.code, discountType: a.discount_type, discount: a.discount, validUntil: a.valid_until,
    validFrom: a.valid_from, minOrderAmount: a.min_order_amount, singleUse: a.single_use, templateId: a.template_id, note: a.note })));

  server.registerTool('shoptet_propose_redirect', {
    title: 'Propose: add URL redirect', annotations: PROPOSE,
    description: 'Prepare a redirect from a path to a path or absolute URL. Refuses "/" and /admin, and sources that are already redirected. Changes nothing yet.',
    inputSchema: { from: z.string().max(300), to: z.string().max(500) },
  }, run((a) => engine.propose('redirect', { from: a.from, to: a.to })));

  server.registerTool('shoptet_propose_variant_update', {
    title: 'Propose: change variant price / stock', annotations: PROPOSE,
    description: 'Prepare a price and/or stock change for ONE variant, identified by product id + exact variant code. Changes nothing yet.',
    inputSchema: { product_id: z.number().int().positive(), variant_code: z.string().min(1).max(100), price: z.number().min(0).optional(), stock: z.number().int().min(0).optional() },
  }, run((a) => engine.propose('variant', { productId: a.product_id, code: a.variant_code, price: a.price, stock: a.stock })));

  server.registerTool('shoptet_propose_html_code_change', {
    title: 'Propose: replace an HTML code field', annotations: PROPOSE,
    description: 'Prepare replacing the full content of header, footer or orderFinale. Read the current value first with shoptet_get_html_codes and send the complete new value. Changes nothing yet.',
    inputSchema: { field: z.enum(['header', 'footer', 'orderFinale']), new_value: z.string().max(200000) },
  }, run((a) => engine.propose('html_code', { field: a.field, newValue: a.new_value })));

  server.registerTool('shoptet_propose_banner_change', {
    title: 'Propose: replace banner content', annotations: PROPOSE,
    description: 'Prepare replacing the HTML content of one banner. Read it first with shoptet_get_banner and send the complete new content. Changes nothing yet.',
    inputSchema: { banner_id: z.string().regex(/^[A-Za-z0-9_-]+$/), new_content: z.string().max(200000) },
  }, run((a) => engine.propose('banner', { bannerId: a.banner_id, newValue: a.new_content })));

  server.registerTool('shoptet_apply_change', {
    title: 'Apply a proposed change', annotations: CHANGE,
    description: 'WRITES TO THE LIVE SHOP. Apply a draft from a shoptet_propose_* tool. Only call after the user has seen the draft summary and explicitly agreed in this conversation. Re-checks the state, writes, then verifies.',
    inputSchema: { draft_id: z.string().regex(/^d-[0-9a-f]{8}$/) },
  }, run((a) => engine.apply(a.draft_id)));

  server.registerTool('shoptet_revert_change', {
    title: 'Revert an applied change', annotations: CHANGE,
    description: 'WRITES TO THE LIVE SHOP. Undo an applied draft (coupon: ends validity; redirect: removes it; others: restores the old value if unchanged since). Needs explicit user agreement.',
    inputSchema: { draft_id: z.string().regex(/^d-[0-9a-f]{8}$/) },
  }, run((a) => engine.revert(a.draft_id)));

  server.registerTool('shoptet_list_changes', {
    title: 'List drafts and applied changes', annotations: READ,
    description: 'Local list of drafts made through this server and their status. Does not contact the shop.',
    inputSchema: {},
  }, run(async () => ({ changes: store.list() })));
}

const shutdown = async () => { await session.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
log(`ready for ${cfg.host}; write tools ${cfg.allowWrite ? 'ENABLED' : 'disabled'}`);
