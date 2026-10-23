<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="Egor Nefedov" width="260">
  </picture>
</p>

# shoptet-admin-mcp

**Claude in your Shoptet admin. With guardrails.**

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) server and a Claude skill. They let an AI assistant read and carefully change things in a [Shoptet](https://www.shoptet.cz) e-shop admin by driving it in a real browser with [Playwright](https://playwright.dev). Nothing is hosted: it runs on your computer.

> **Experimental (alpha).** Verified on one Czech-language shop, on macOS. Expect breakage when Shoptet changes its admin. Read [Status](#status) before you put a password into it.
>
> Not affiliated with, endorsed by, or supported by Shoptet. "Shoptet" is a trademark of its owner.

| 11 | 5 | 0 | 27 |
|:--|:--|:--|:--|
| read tools | guarded writes | deletes, by design | offline tests |

Every number above is a count of what is in this repository. Nothing here is a benchmark or a customer claim.

## Why this exists

Shoptet has no public API for much of what an operator does in the admin: coupons, redirects, banners, HTML codes, price lists. I automate e-shop admins for Czech companies, and the same traps cost me hours every time: a firewall that blocks your whole IP, tables that render in batches, forms that silently drop typed text. This repository is those lessons, rewritten from scratch as a small tool with the safety rules built in, plus the notes in a form Claude can use.

## What it does

**Read, always on:** shop info, products, product detail, price list (variants, prices, stock), coupons and coupon templates, URL redirects, banners, HTML codes, orders without personal data.

**Write, off by default:** create a coupon, add a redirect, change price or stock of one variant, replace an HTML code field, replace a banner.

A write is never one shot:

```
propose  →  you read the summary and say yes  →  apply  →  verify  →  revert if needed
(nothing changes)                                (re-check, write, re-read)
```

Nothing is deleted. Reverting a coupon ends its validity. Reverting a redirect removes only the rule this tool added.

## Status

- Verified on **macOS**, on a **Czech-language** admin, on a staging clone shop, October 2026: every read tool, and each write kind through propose, apply, independent re-read and revert.
- **Not tested:** Windows, Linux, Slovak or English admin, accounts with two-factor login, other plans.
- Automating the admin may not be allowed on every Shoptet plan. **Checking Shoptet's terms for your plan is your responsibility.**
- Shoptet changes its admin without notice. Writes verify the result and fail loudly instead of guessing, but selectors will need updates over time.
- Offline unit tests cover config, input validation, the draft lifecycle and storage. The browser parts were verified by hand against a live admin, not in CI.

## Install

Node.js 20.6 or newer.

```bash
git clone https://github.com/egornefedovcz/shoptet-admin-mcp.git
cd shoptet-admin-mcp
git checkout <release-tag>   # pin a tagged release instead of tracking main, and read the code first (it is small)
npm install
npx playwright install chromium
cp .env.example .env         # fill in SHOPTET_URL, SHOPTET_EMAIL, SHOPTET_PASSWORD
chmod 600 .env
```

Use a **dedicated admin user** with only the permissions you need. Try it on a **staging or clone shop** first.

### Claude Code

```bash
claude mcp add shoptet -- node --env-file=/absolute/path/to/shoptet-admin-mcp/.env /absolute/path/to/shoptet-admin-mcp/src/server.js
```

`--env-file` keeps the password out of your shell history and out of Claude's config.

### Claude Desktop and other clients

```json
{
  "mcpServers": {
    "shoptet": {
      "command": "node",
      "args": ["--env-file=/absolute/path/to/shoptet-admin-mcp/.env", "/absolute/path/to/shoptet-admin-mcp/src/server.js"]
    }
  }
}
```

### Enable writes (optional)

Add `SHOPTET_ALLOW_WRITE=1` to `.env` and restart the client. Without it the write tools are not registered at all, so the model cannot even see them. When you enable writes, **do not auto-approve** `shoptet_apply_change` and `shoptet_revert_change`. Your own confirmation on those two calls is the real safety gate ([why](docs/safety.md)).

### The skill

```bash
cp -r skills/shoptet-admin ~/.claude/skills/
```

It works with or without the server. It tells Claude how to use the tools, and how to write safe Playwright scripts for what the tools do not cover.

## Tools

| Tool | Writes | Purpose |
|---|---|---|
| `shoptet_shop_info` | no | Log in, show which shop is connected and whether writes are on |
| `shoptet_list_products` | no | Product list (id, name, price), optional name filter |
| `shoptet_get_product` | no | Name, visibility, descriptions (truncated) |
| `shoptet_get_price_list` | no | Variants: id, name, code, price, stock |
| `shoptet_list_coupons`, `shoptet_list_coupon_templates` | no | Coupons and the templates they can use |
| `shoptet_list_redirects` | no | URL redirects, optional source filter |
| `shoptet_list_banners`, `shoptet_get_banner` | no | Banners and their HTML |
| `shoptet_get_html_codes` | no | header, footer, orderFinale, robots, llms fields |
| `shoptet_list_orders` | no | Recent orders without names, e-mails or addresses |
| `shoptet_propose_coupon` | draft only | New coupon, 3 to 16 characters, mandatory end date |
| `shoptet_propose_redirect` | draft only | New redirect, refuses `/` and `/admin` |
| `shoptet_propose_variant_update` | draft only | Price and/or stock of one variant (product id and exact code) |
| `shoptet_propose_html_code_change` | draft only | Replace `header`, `footer` or `orderFinale` |
| `shoptet_propose_banner_change` | draft only | Replace one banner's HTML |
| `shoptet_apply_change` | **yes** | Apply a draft: re-check, write, verify |
| `shoptet_revert_change` | **yes** | Undo an applied draft |
| `shoptet_list_changes` | no | Local list of drafts and their status |

## Where your data goes

Nothing is hosted by the author. The server and its browser run on your computer and talk only to your shop. There is no telemetry and no account. But whatever the tools return (product texts, banners, coupons, order lists without personal data) is sent to **the AI model you use**, for example Claude. Treat it like pasting that data into a chat.

## How it stays out of trouble

- **Slow and serial.** One browser, one request at a time, at least 2.5 s apart. Shoptet's firewall blocks a whole IP, storefront and admin, for bursts. A 403 or 429 opens a 30 minute circuit breaker.
- **Verify everything.** A write refuses if the value changed since the proposal, then re-reads the target and the neighbouring fields and compares.
- **The browser only goes where the server sends it.** It visits admin pages built from ids, codes and paths. No tool navigates to a URL the model supplies. The shop origin is fixed by `SHOPTET_URL`.
- **Secrets stay in the environment.** The password is never logged or returned, and is scrubbed from error text.
- **Shop content is labelled untrusted** in every read result.

More: [how it works](docs/how-it-works.md), [safety model](docs/safety.md), [skill references](skills/shoptet-admin/references/).

## Limitations

- One shop per server instance. Run several instances for several shops.
- The product list reads what the admin shows on one page. No pagination yet.
- Product text editing, file upload, order changes and label printing are deliberately left out.
- The browser is discarded after every write, so the next call logs in again, a few extra seconds. See "Session state" in [quirks](skills/shoptet-admin/references/quirks.md).

## Development

```bash
npm test      # offline unit tests, no shop needed
```

To try a change against a real admin, use a staging shop and `SHOPTET_HEADED=1`. Do not commit shop data, screenshots of admin pages or HTML copied from a real shop. Security problems go through [private reporting](SECURITY.md), not public issues.

## About

I am Egor Nefedov, Prague. I build automations and internal apps that take retyping, spreadsheets and repeated questions off people's hands in Czech companies. More at [nefedov.cz](https://nefedov.cz).

MIT licence, see [LICENSE](LICENSE). Czech version: [README.cs.md](README.cs.md).
