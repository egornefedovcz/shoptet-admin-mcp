import { chromium } from 'playwright';
import { sleep, fail } from './util.js';

const TRANSIENT = /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|ERR_CONNECTION_CLOSED/;
const WAF_TEXT = /Access temporarily blocked|suspicious activity/i;

/**
 * One logged-in Playwright browser, shared by all tools.
 *
 * - Calls are serialized (`exclusive`): the admin is fragile under parallel load.
 * - Every navigation is throttled with a minimum delay plus jitter.
 * - A WAF block (HTTP 403/429 or the "Access temporarily blocked" page) trips a
 *   circuit breaker: further requests are refused for a cool-down instead of
 *   digging the hole deeper.
 */
export class Session {
  constructor(cfg) {
    this.cfg = cfg;
    this.browser = null;
    this.page = null;
    this.lastNav = 0;
    this.blockedUntil = 0;
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.csrfToken = null;
  }

  /** Run `fn(session)` with exclusive access to the browser. */
  exclusive(fn) {
    const run = this.queue.then(async () => {
      clearTimeout(this.idleTimer);
      try { return await fn(this); }
      finally { this.armIdleTimer(); }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  armIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.cfg.idleCloseMs);
    this.idleTimer.unref?.();
  }

  async close() {
    clearTimeout(this.idleTimer);
    const b = this.browser;
    this.browser = null; this.page = null; this.csrfToken = null;
    if (b) await b.close().catch(() => {});
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: !this.cfg.headed });
    }
    const ctx = await this.browser.newContext({ locale: 'cs-CZ', viewport: { width: 1440, height: 1000 } });
    this.page = await ctx.newPage();
    // The admin embeds a floating onboarding widget (Userpilot iframe) that intercepts clicks on
    // elements underneath it, e.g. the delete button in the redirect list. Hide it on every page.
    await this.page.addInitScript(() => {
      const css = 'iframe[id^="userpilot"], [id^="userpilot"] { display: none !important; pointer-events: none !important; }';
      const add = () => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
    });
    this.csrfToken = null;
    await this.login();
    return this.page;
  }

  checkBreaker() {
    if (Date.now() < this.blockedUntil) {
      const min = Math.ceil((this.blockedUntil - Date.now()) / 60000);
      fail(`Shoptet's firewall blocked this IP recently. Not sending more requests for ~${min} min. If it persists, contact Shoptet support and ask them to allow your IP.`);
    }
  }

  tripBreaker(why) {
    this.blockedUntil = Date.now() + this.cfg.blockCooldownMs;
    fail(`Shoptet's firewall blocked this IP (${why}). Pausing all requests for ${Math.round(this.cfg.blockCooldownMs / 60000)} min. Reduce request volume; see docs/quirks.md.`);
  }

  async throttle() {
    const wait = this.lastNav + this.cfg.minDelayMs + Math.random() * 500 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastNav = Date.now();
  }

  /** Navigate inside the admin. `path` is relative to the shop origin, e.g. "/admin/produkty/". */
  async go(path, { waitUntil = 'domcontentloaded', relogin = true } = {}) {
    if (!path.startsWith('/')) fail('Internal error: path must start with "/"');
    this.checkBreaker();
    const page = this.page ?? await this.ensurePage();
    let res = null;
    for (let i = 1; ; i++) {
      await this.throttle();
      try { res = await page.goto(this.cfg.origin + path, { waitUntil, timeout: 90000 }); break; }
      catch (e) {
        if (i >= 4 || !TRANSIENT.test(e.message)) throw e;
        await sleep(5000 * i);
      }
    }
    await this.assertNotBlocked(res);
    if (relogin && new URL(page.url()).pathname.includes('/login')) {
      await this.login();
      return this.go(path, { waitUntil, relogin: false });
    }
    return page;
  }

  async assertNotBlocked(res) {
    const status = res?.status();
    if (status === 403 || status === 429) {
      const body = await this.page.locator('body').innerText().catch(() => '');
      if (status === 429 || WAF_TEXT.test(body)) this.tripBreaker(`HTTP ${status}`);
    }
  }

  async login() {
    const page = this.page;
    this.checkBreaker();
    await this.throttle();
    const res = await page.goto(`${this.cfg.origin}/admin/login/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.assertNotBlocked(res);
    if (!new URL(page.url()).pathname.includes('/login')) return;
    // Field names are language-independent, unlike placeholders and button labels.
    await page.fill('input[name=email]', this.cfg.email);
    await page.fill('input[name=password]', this.cfg.password);
    try {
      await Promise.all([
        page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 45000 }),
        page.press('input[name=password]', 'Enter'),
      ]);
    } catch {
      const msg = await page.locator('[role=alert], .alert, .message--error, [class*=error]').first().innerText({ timeout: 2000 }).catch(() => '');
      fail(`Login to ${this.cfg.host} failed${msg ? `: ${msg.replace(/\s+/g, ' ').slice(0, 160)}` : ''}. Check SHOPTET_EMAIL/SHOPTET_PASSWORD. Accounts that require a second factor are not supported.`);
    }
    this.csrfToken = null;
  }

  /**
   * The CSRF token is per session, not per form, and many detail pages
   * (e.g. coupon detail) do not contain one. Read it from any page that does.
   */
  async csrf() {
    if (this.csrfToken) return this.csrfToken;
    const read = () => this.page.evaluate(() => document.querySelector('input[name="__csrf__"]')?.value ?? null);
    let t = this.page ? await read() : null;
    if (!t) { await this.go('/admin/slevove-kupony/'); t = await read(); }
    if (!t) fail('Could not find a CSRF token in the admin. The admin layout may have changed.');
    this.csrfToken = t;
    return t;
  }

  /** Submit a form natively, appending buttonAction and the CSRF token as hidden fields. */
  async submitForm(formSelector, buttonAction) {
    // Must have been fetched earlier: fetching now would navigate away from the filled-in form.
    const token = this.csrfToken;
    if (!token) fail('Internal error: call csrf() before opening a form that is submitted with submitForm().');
    const page = this.page;
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'commit', timeout: 90000 }).catch(() => {}),
      page.evaluate(({ sel, token, buttonAction }) => {
        const form = document.querySelector(sel);
        if (!form) throw new Error('form not found: ' + sel);
        for (const [name, value] of [['buttonAction', buttonAction], ['__csrf__', token]]) {
          form.querySelectorAll(`input[type=hidden][name="${name}"]`).forEach((n) => n.remove());
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = name; input.value = value;
          form.appendChild(input);
        }
        form.submit();
      }, { sel: formSelector, token, buttonAction }),
    ]);
    await sleep(1500);
  }

  /** Wait until the admin's loading overlays (there can be several) are gone. */
  async waitForOverlays(timeout = 60000) {
    await this.page.waitForFunction(
      () => [...document.querySelectorAll('.loaderArea--screen')].every((e) => !e.checkVisibility()),
      null, { timeout },
    ).catch(() => {});
  }
}
