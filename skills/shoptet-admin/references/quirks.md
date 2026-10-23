# Shoptet admin quirks

Legend: **[verified]** = reproduced against a real shop's Czech-language admin while building `shoptet-admin-mcp` (Oct 2026).
**[seen]** = taken from older automation scripts and notes; behaviour was observed then but not re-tested for this project.
Shoptet changes its admin without notice. Treat selectors as hints and let your verification step catch drift.

## 1. Firewall (WAF) - the one that really hurts

- **[seen]** Shoptet's firewall answers `403` with "Access temporarily blocked … suspicious activity that looked like an attack" and blocks the **whole IP**: storefront, admin and CDN. Two incidents:
  - A crawl of ~1,100 requests over 8 threads plus HEAD checks of ~520 images over 12 threads, from one laptop IP.
  - A server running several periodic jobs (an order export every minute, a full export every 2 minutes, a page-scraper every 5 minutes, calendar fetches of ~40 pages in batches of 4) plus two restarts that re-fetched everything.
- The server's block lasted about 1.5 hours. What ended it: an email to Shoptet support, who added the IP to an allow-list a few minutes later.
- Rules of thumb: serial requests; ≥0.5 s between storefront requests, ≥2.5 s in the admin (what this project uses); hundreds of requests, not thousands; don't fetch the same thing twice from two jobs; poll exports rarely.
- Do **not** try to get around a block with another IP or a proxy. That is evading someone else's protection and will get you in worse trouble.
- Verify uploaded files by listing them over SFTP instead of HEAD-ing hundreds of URLs.
- **[verified]** `shoptet-admin-mcp` trips a circuit breaker on 403/429 and refuses further requests for 30 minutes.

## 2. Login

- **[verified]** `/admin/login/` has a form with `input[name=email]`, `input[name=password]` and a hidden `__csrf__`. Placeholders ("E-mail", "Vaše heslo") and the button label ("Přihlášení") are localized, so fill by `name` and press Enter.
- After success the URL is no longer under `/login`. If you get bounced back to `/login` later, the session expired: log in again and retry once.
- Accounts with a second factor are **not handled** by this project (never tested). Use a dedicated admin user with only the rights you need.

## 3. Loading and waiting

- **[verified]** Tables (products, coupons, redirects, orders) render in batches. Poll the row count until two consecutive reads match.
- **[verified]** A filtered list with no matches has no rows; cap the "wait for first row" at ~10 s.
- **[verified]** Product detail with ~80 variants: wait for `a[href="#cenik"]`, then wait until all `.loaderArea--screen` overlays are hidden (`el.checkVisibility()` is false for every one; there can be several). Clicking earlier hits the overlay.
- **[seen]** For such pages `page.goto(..., { waitUntil: 'commit' })` is the safe choice; `load` may never fire.
- **[verified]** Transient network errors (`ERR_NETWORK_CHANGED`, `ERR_CONNECTION_RESET`, `ERR_TIMED_OUT`, …) happen; retry the navigation a few times with growing pauses.

## 4. Forms, CSRF, saving

- **[verified]** The CSRF token is one per session (`input[name="__csrf__"]`). It exists on list pages; the coupon *detail* page has none. If you navigate away to fetch it after filling a form, you lose the form. Read it first.
- **[verified]** Native submit works: append hidden inputs `buttonAction` (`add` for a new record, `saveAndStay` to save an existing one) and `__csrf__`, then `form.submit()`.
- **[verified]** Buttons: `[data-testid="buttonSaveAndStay"]` on HTML codes, banners, product. The price list uses a link "Uložit". Match labels with regexes (`/^(Uložit|Uložiť|Save)$/i`).
- **[verified]** Date fields use `dd.mm.yyyy`. Coupon codes: 3-16 chars, A-Z 0-9 and hyphen.
- **[verified]** Banner content (`textarea[name=content]`) is React-controlled: setting `.value` is ignored; use `fill()`. In one session state the field kept reverting the typed text; verify after filling, before clicking save.
- **[verified]** HTML codes (`/admin/html-kody/`): fields are CodeMirror editors (`header`, `footer`, `orderFinale`, `robotsFile`, `llmsFile`). Read with `cm.CodeMirror.getValue()`, write with `setValue()` then `save()` (copies into the textarea that gets submitted). The "Save" button there posts all fields; re-read and check the others did not change.
- **[seen]** Header/footer HTML codes were limited to 8,192 bytes each.
- **[seen]** Product form contains rich-text fields (TinyMCE). Saving the price list or related products submits the whole form, and TinyMCE may re-format descriptions. Safe pattern: fetch the page HTML server-side, call `tinymce.remove()`, set each textarea to the raw server value, then save; afterwards compare all text fields to the raw values.

## 5. Session state weirdness

- **[verified]** After saving the HTML-code page, a banner edit in the *same browser session* silently failed (typed text reverted, save button not clickable), even after reloading or waiting a minute. A fresh browser (new login) fixed it. Cause unknown. `shoptet-admin-mcp` discards the browser after every write.
- **[verified]** A floating onboarding widget (`iframe#userpilot-checklist`) can sit over buttons and intercept clicks. Hide `iframe[id^="userpilot"]` with an init-script stylesheet.
- **[verified]** Occasionally Playwright reports `<body> intercepts pointer events` for a button that visually is fine; that was the symptom of the form re-rendering underneath. Look at the field value, not just the click.

## 6. Files, CDN, SFTP

- **[seen]** File manager (`/admin/spravce-souboru/`) is an iframe (`filemanager/dialog.php`) with a Dropzone (`#myAwesomeDropzone`). Its root is `/user/documents/upload/` on the storefront. It becomes very slow after ~650 files in one folder (uploads >10 minutes).
- **[seen]** SFTP is an alternative: host `ftp.myshoptet.com`, credentials created in the admin (a dedicated deploy user), root `/user/documents/`. Password auth only, so scripts need `sshpass` or a library; pass the secret via environment, never on the command line.
- **[seen]** After upload the CDN is **briefly inconsistent**: some nodes return 200, others 404, for a while. Before switching any reference to a new file, probe it repeatedly (e.g. 10 consecutive correct responses) and compare a hash.
- **[seen]** Never overwrite a file in place. Put a content hash in the name (`app.3fa9c1d2.js`) so references can be switched atomically and reverted.

## 7. Variants and parameters

- **[verified]** Price list rows: `[data-testid="tableCellVariantName"]`; inputs `price[<variantId>]`, `variantCode[<variantId>]`, `variantStock[<variantId>]`. Row count must match what you read; if not, re-read.
- **[seen]** Variant templates (`/admin/generator-variant/?id=…`) and "add variants" (`/admin/pridat-varianty-produktu/?productId=…`) run without CSS/jQuery in places: submit those forms natively with the CSRF token; the list of value labels is available from `/admin/action/ProductDetailAddVariants/GetVariant/?variantId=<templateId>`.
- **[seen]** Parameter values have a detail form per language: `/admin/parametry-hodnoty-detail-multiselect/?parameterId=<id>&id=<valueId>&language=<cs|en|…>`; the value input is `input[name=value]`. Rename per language and re-read each.

## 8. Orders

- **[verified]** `/admin/prehled-objednavek/` lists orders (250 rows by default). The status cell contains a `<select>`; the current status is the *selected* option, not the cell text.
- Treat everything on order pages as personal data (names, e-mails, addresses, phone numbers).
- **[seen]** The order detail page defines a JS function `printShipments([orderId])` for shipping labels; the flow after calling it (carrier popups, PDF) was not reliable enough to include here.

## 9. Misc facts

- **[verified]** Product `visibility` select values on the shop we tested: `0` hidden, `1` visible, `2` visible/cannot order, `3` hidden/logged-in only, `4` visible/buy only logged-in, `5` hidden/visible only in checkout, `6` URL-only/cannot order. Read the options from your own shop; don't assume.
- **[verified]** Coupon templates (`select[name=templateId]`) decide which products a coupon applies to; "all products" is `1` on the shop we tested.
- **[verified]** There is no safe "delete coupon" in the flow; ending validity (set "valid until" to a past date) keeps order history intact.
- **[verified]** The URL-redirect page filters with `?f[fromUrl]=<path>`; adding opens a dialog with `input[name=fromUrl]`, `input[name=toUrl]`; deleting is a row action (title "Smazat položku") followed by a confirm dialog.
