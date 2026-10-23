import os from 'node:os';
import path from 'node:path';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * All configuration comes from environment variables. Nothing is hard-coded,
 * and tools never accept URLs from the model: the shop origin is fixed here.
 */
export function loadConfig(env = process.env) {
  const raw = String(env.SHOPTET_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('SHOPTET_URL is required, e.g. https://myshop.myshoptet.com (no path, no /admin)');
  let url;
  try { url = new URL(raw); } catch { throw new Error(`SHOPTET_URL is not a valid URL: ${raw}`); }
  if (url.protocol !== 'https:') throw new Error('SHOPTET_URL must use https://');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('SHOPTET_URL must be the bare origin, e.g. https://myshop.myshoptet.com');
  if (!env.SHOPTET_EMAIL || !env.SHOPTET_PASSWORD) throw new Error('SHOPTET_EMAIL and SHOPTET_PASSWORD are required');

  return {
    origin: url.origin,
    host: url.host,
    email: env.SHOPTET_EMAIL,
    password: env.SHOPTET_PASSWORD,
    // Write tools are not even registered unless this is set.
    allowWrite: truthy(env.SHOPTET_ALLOW_WRITE),
    // Shoptet's WAF blocks IPs that look like crawlers. Keep requests serial and slow.
    minDelayMs: Math.max(1000, Number(env.SHOPTET_MIN_DELAY_MS) || 2500),
    headed: truthy(env.SHOPTET_HEADED),
    stateDir: env.SHOPTET_STATE_DIR || path.join(os.homedir(), '.shoptet-admin-mcp'),
    draftTtlMs: 60 * 60 * 1000,
    idleCloseMs: 5 * 60 * 1000,
    blockCooldownMs: 30 * 60 * 1000,
  };
}
