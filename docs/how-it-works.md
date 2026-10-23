# How it works

## The idea

Shoptet's admin is a server-rendered web app with a lot of client-side widgets. For much of what an operator does there is no public API, so this server logs in like a person would, in a headless Chromium driven by Playwright, and exposes a few well-defined operations as MCP tools.

```
 MCP client (Claude)                              Shoptet admin
        │  stdio, JSON-RPC                             ▲
        ▼                                              │ HTTPS, one request at a time
┌─────────────────────────────────────────────────────┴───────────┐
│ src/server.js     tool registry, zod schemas, error wrapper      │
│   ├─ readers.js   read-only extractors (tables by header text)   │
│   ├─ engine.js    propose → apply → revert, drafts, audit        │
│   │     └─ writers.js   per-kind handlers: coupon, redirect,     │
│   │                      variant, html_code, banner              │
│   ├─ store.js     drafts + audit log on local disk (0700)        │
│   └─ session.js   ONE browser: login, throttle, WAF breaker,     │
│                    CSRF, serialized access                        │
│ src/config.js     env → config, validation                       │
└──────────────────────────────────────────────────────────────────┘
```

## One process, one browser, one lane

`Session` owns a single Chromium page. `exclusive(fn)` queues callers so only one tool touches the browser at a time. Parallel tool calls from the client simply wait their turn. Every navigation goes through `go(path)`, which:

1. refuses if the circuit breaker is open,
2. waits so that consecutive navigations are at least `SHOPTET_MIN_DELAY_MS` (+ up to 0.5 s jitter) apart,
3. retries a few transient network errors with growing pauses,
4. on HTTP 429, or 403 with the firewall's "Access temporarily blocked" text, **opens the breaker for 30 minutes** and raises an error,
5. if the admin bounced us to `/login`, logs in again and retries once.

The browser is started lazily, logs in on first use, and closes after 5 idle minutes.

## Reading

Readers return plain objects. Tables are parsed by **header text** (cs/sk/en regexes), not column position, so a re-ordered column does not silently return the wrong data. Rows are fetched only after the row count stops growing, because the admin renders tables in batches. Cells that contain a `<select>` (order status) report the *selected* option.

Orders deliberately omit the customer name column. Everything read from the shop is returned with a leading note that it is untrusted data.

## Writing: propose → apply → revert

```
propose(kind, params)         apply(draft_id)                    revert(draft_id)
  read current state            status must be "proposed",         read current state
  validate input                not expired (1 h)                  if already original → nothing to do
  store BEFORE snapshot         re-read: same as BEFORE?           if still equals what apply wrote
  return summary + draft id       no → refuse ("changed since")      → restore BEFORE, verify
        │                       write                                otherwise → refuse
        │                       re-read, compare target + others   (never overwrite someone's later change)
        ▼                       status "applied" / "failed"
   user reads summary  ──yes──►  fresh browser afterwards
```

Per kind:

| Kind | Apply does | Verifies | Revert |
|---|---|---|---|
| `coupon` | Fills the coupon form, submits with CSRF | The code is listed with the right end date | Sets "valid until" to yesterday (never deletes) |
| `redirect` | "Add" dialog → from/to → save | The rule is listed | Deletes exactly that row, with confirmation dialog |
| `variant` | Sets `price[id]` / `variantStock[id]` in the price list, restores raw rich-text HTML first, saves | New values; all other product form fields unchanged | Writes the old values if the current ones are still the applied ones |
| `html_code` | CodeMirror `setValue` + `save()`, "Save and stay" | Target field exact; all other fields unchanged | Writes the old content back |
| `banner` | Fills the React textarea, confirms the value survived, saves | Content exact; other banner settings unchanged | Writes the old content back |

Drafts live in `SHOPTET_STATE_DIR` (default `~/.shoptet-admin-mcp`, mode 0700) as JSON, with a JSONL audit log. They contain the "before" snapshot of whatever you change, but never credentials. Draft ids are `d-` plus 8 hex characters and are validated before touching the filesystem.

A crash mid-apply leaves the draft in `applying`; revert is allowed from `applying`, `applied` and `failed`, and each handler decides from the live state what (if anything) to undo.

### Why the browser is thrown away after every write

While building this, saving the HTML-code page left the browser session in a state where a *different* form (a banner) silently discarded typed text, even after reload and waiting a minute. A fresh browser fixed it, so every apply/revert ends by closing the browser (the next call logs in again). The root cause was not identified; the engine comment and `quirks.md` say so.

## What the server will not do

- Navigate to a URL the model supplies. Tools accept ids, codes and paths; the origin is fixed.
- Register write tools unless `SHOPTET_ALLOW_WRITE=1`.
- Delete coupons, products, banners or anything else.
- Return customer names, e-mails or addresses from orders.
- Send more than one request at a time, or faster than the configured delay.

## Testing

- `npm test`: offline `node:test` suites for config, validation, the draft lifecycle (with fake handlers) and storage. They need neither a browser nor a shop.
- The browser code was verified by hand against a live Czech admin on a staging shop: all reads, and each write kind through propose → apply → independent re-read → revert, checking the shop returned to its original state. There is no CI job for this because it needs a real shop and credentials.

## Adding a tool

1. **Read**: add an extractor in `readers.js` (map columns by header regex, wait for the table), register it in `server.js` with `readOnlyHint` and, if it returns shop text, `{ untrusted: true }`.
2. **Write**: add a handler `{ propose, apply, revert }` in `writers.js` and put it in `HANDLERS`. Propose must not change the shop. Apply must re-check the state and verify afterwards. Revert must only undo what apply did. Register a `shoptet_propose_*` tool in the `if (cfg.allowWrite)` block.
3. Test the validation offline, then run the full cycle on a staging shop before sending a pull request.
