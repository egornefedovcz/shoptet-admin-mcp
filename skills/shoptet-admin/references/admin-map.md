# Admin map

Paths are relative to the shop origin (`https://<shop>.myshoptet.com` or its custom domain). Czech admin; Slovak/English labels differ but paths and field names are the same.

- **opened** = opened and parsed with this project's code (Oct 2026).
- **linked** = present in the admin navigation of a test shop, not opened by this project.
- **seen** = used by older scripts; not re-tested.

## Pages used by `shoptet-admin-mcp`

| Path | What | Key selectors / fields | Status |
|---|---|---|---|
| `/admin/login/` | Login | `input[name=email]`, `input[name=password]`, hidden `__csrf__` | opened |
| `/admin/` | Dashboard (title shows the shop host) | - | opened |
| `/admin/produkty/` | Product list (≈100+ rows in one page) | headers Název / Cena / Viditelnost; link `produkty-detail/?id=<n>` | opened |
| `/admin/produkty-detail/?id=<n>` | Product detail | `form#main-form`; fields `name`, `shortDescription`, `description`, `visibility`; tab `a[href="#cenik"]` | opened |
| (price list tab) | Variants | `[data-testid="tableCellVariantName"]`; `price[<vid>]`, `variantCode[<vid>]`, `variantStock[<vid>]`; save = link "Uložit" | opened |
| `/admin/slevove-kupony/` | Coupon list | filter `?f[code]=<code>`; headers Kód / Sleva / Šablona / Použito / Platný od / Platný do / Od částky; link `slevove-kupony-detail/?id=<n>` | opened |
| `/admin/slevove-kupony-detail/[?id=<n>]` | Create / edit coupon | `code`, `discountType` (`fixed`\|`percentual`), `discount`, `templateId`, `delivery`, `validFrom`, `validUntil`, `fromAmount`, `remark`, `multipleUsability`, radio `addMoreCoupons` (0 = one coupon); no `__csrf__` on this page | opened |
| `/admin/presmerovani-url/` | URL redirects | filter `?f[fromUrl]=<path>`; headers Z adresy / Na adresu / Automaticky vložené pravidlo; "Přidat" opens a dialog (`fromUrl`, `toUrl`, "Uložit"); row action title "Smazat položku" + confirm "Ok" | opened |
| `/admin/bannery/` | Banner list | link `bannery-detail/<bannerId>` (id like `banner2`) | opened |
| `/admin/bannery-detail/<bannerId>` | Banner edit | `textarea[name=content]` (React), other inputs: title, type, dates, visible, desktop/mobile; save `[data-testid="buttonSaveAndStay"]`; `?language=<xx>` for another language | opened |
| `/admin/html-kody/` | Custom HTML codes | CodeMirror fields `header`, `footer`, `orderFinale`, `robotsFile`, `llmsFile`; selects `contentSignal*`; form `#main-form`; save `[data-testid="buttonSaveAndStay"]` | opened |
| `/admin/prehled-objednavek/` | Order list (250 rows) | headers Kód a datum / Jméno a příjmení (**personal data**) / Způsob dopravy / Platba / Stav (a `<select>`) / Cena / Prodejní kanál; link `objednavky-detail/?id=<n>` | opened |

## Other pages (reference)

| Path | What | Status |
|---|---|---|
| `/admin/objednavky-detail/?id=<n>` | Order detail (personal data; JS `printShipments([id])`) | seen |
| `/admin/objednavky-export/`, `/admin/export-produktu/`, `/admin/import-produktu/`, `/admin/export-zakazniku/` | CSV exports/imports | linked |
| `/admin/ceny/`, `/admin/sklad/`, `/admin/slevy/` | Bulk prices, stock, discounts | linked |
| `/admin/kategorie/`, `/admin/kategorie-detail/` | Categories | linked / seen |
| `/admin/zakaznici/`, `/admin/prehled-zakazniku/` | Customers (**personal data**) | linked |
| `/admin/menu/` | Menu editor | linked |
| `/admin/clanky/`, `/admin/clanek-rubrika-detail/`, `/admin/clanky-rubriky/` | Blog articles and sections | linked / seen |
| `/admin/stranky/`, `/admin/stranka-detail/?id=<n>` | Static pages | linked / seen |
| `/admin/spravce-souboru/` | File manager (iframe + Dropzone) | seen |
| `/admin/generator-variant/?id=<templateId>` | Variant template (parameter value lists) | seen |
| `/admin/pridat-varianty-produktu/?productId=<n>` | Add variants from a template | seen |
| `/admin/parametry-variant-detail/?id=<paramId>` | Variant parameter and its values | seen |
| `/admin/parametry-hodnoty-detail-multiselect/?parameterId=<p>&id=<v>&language=<xx>` | One parameter value per language | seen |
| `/admin/zasilky/`, `/admin/prepravci/`, `/admin/zpusoby-dopravy/` | Shipments, carriers, shipping methods | linked / seen |
| `/admin/sablony-emailu-objednavky-detail/` | Order e-mail templates | seen |
| `/admin/navrhar-sablon/`, `/admin/casti-sablon/`, `/admin/editor-vzhledu/` | Template designer / parts | linked / seen |
| `/admin/zkopirovat-produkt/` | Copy product | seen |

Field names such as `statusId[<orderId>]` (order status select) are also internal and can change.
