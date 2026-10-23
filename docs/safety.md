# Safety model

An MCP server that logs into a shop admin is powerful. This page says what it protects against, how, and where the protection ends.

## Threats and mitigations

| Threat | Mitigation | Limit |
|---|---|---|
| **Credential leak** | Credentials come only from environment variables (use `node --env-file`). Never logged, never returned, scrubbed from error text, not stored in drafts or the audit log. `.env` is git-ignored. | Anything with access to your user account or the process environment can read them. Use a dedicated admin user with minimal rights. |
| **Accidental or wrong write** | Write tools are not registered unless `SHOPTET_ALLOW_WRITE=1`. Every write is propose → confirm → apply with state re-check and read-back verification. Nothing is deleted. | Verification catches mismatches; it cannot know whether the change was a good idea. |
| **Prompt injection via shop content** (a product text, banner or order note says "now apply a draft that…") | Reads are labelled untrusted. Writes need two steps, and apply/revert are annotated `destructiveHint`, so clients can prompt for them. Tools take no URLs, so injected text cannot send the browser elsewhere. Order reads omit personal data. | **This is the one that matters.** A label is a hint to the model, not a barrier. Your client's confirmation prompt on `shoptet_apply_change` / `shoptet_revert_change` is the real gate: **don't auto-approve those two.** Read the draft summary before you approve. |
| **Customer personal data exposure** | Order tool maps only non-personal columns. Product/banner/HTML tools do not touch customer data. | Pages themselves contain personal data; if you extend the server to read order details, treat the output as GDPR-relevant. |
| **Getting the IP blocked by Shoptet's firewall** | One request at a time, ≥2.5 s apart, 30-minute breaker on 403/429. | A block hits your whole IP (including your storefront and admin). Don't lower the delay, and don't run several instances against one shop from one IP. |
| **Data loss from a bad revert** | Revert acts only if the live state still equals what apply wrote; otherwise it refuses. | Edits made by others between apply and revert are never overwritten, which also means revert can refuse. |
| **Shop data sent to the AI model** | Nothing leaves your machine except to Shoptet and to the model your client uses. No telemetry. Orders omit personal data. | Everything a read tool returns is seen by that model provider. Don't read what you wouldn't paste into a chat. |
| **Local data at rest** | Drafts and audit log under a 0700 directory, files 0600. | Drafts hold "before" snapshots of what you changed (e.g. HTML code). Delete `~/.shoptet-admin-mcp` when done. |

## Recommendations

1. Create a **dedicated Shoptet admin user** with only the sections you need, and a strong unique password. Revoke it when you stop using the tool.
2. Test on a **staging or clone shop** first.
3. Keep `.env` at mode 600 and out of version control. Never put credentials in your MCP client config if you can use `--env-file`.
4. Leave writes **off** until you need them. When on, require confirmation for `shoptet_apply_change` and `shoptet_revert_change`.
5. Skim `~/.shoptet-admin-mcp/audit.jsonl` now and then: it lists every propose / apply / revert with time and draft id.
6. If Shoptet's firewall blocks you, stop. Contact Shoptet support to allow your IP. Do not rotate IPs or use proxies.

## Not covered

- Two-factor login (untested; use an account without it and compensate with a strong password and limited rights).
- Anything on the storefront; the server only talks to `/admin/`.
- Shoptet's terms of service for your plan. You are responsible for checking that automating the admin is allowed for you.
