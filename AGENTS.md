# AGENTS.md

Project guidance for coding agents working on StockBridge.

## Project Overview

StockBridge is a Vite + React frontend with an Express API deployed on Vercel.
It helps Diesel Power Products manage product availability, vendor stock checks,
follow-up dates, product notes, and SKU Nexus catalog/vendor data.

The GitHub repo is `DieselPowerProducts/StockBridge`. The main working branch is
usually `main`. The Vercel project is `stock-bridge` under the
`dieselpowerproducts-projects` team.

## Stack And Layout

- Frontend: React 19, TypeScript, Vite.
- Backend: Express 5 server under `server/`, exposed through Vercel functions.
- API entrypoint: `api/index.js`.
- Scheduled sync entrypoints: `api/cron/catalog-full-sync.js`,
  `api/cron/catalog-warehouse-sync.js`, and `api/cron/auto-inventory.js`.
- Event-driven Shopify availability consumer:
  `api/queues/shopify-availability-sync.js`.
- Authenticated manual Shopify availability recovery endpoint:
  `api/cron/shopify-availability-sync.js`. It is intentionally not scheduled.
- Database: Neon Postgres via `@neondatabase/serverless`.
- External systems: SKU Nexus, Shopify, Gmail SMTP.
- Active browsers poll `/status/version` once per minute and force a page reload
  when Vercel's deployed build version changes.
- Main frontend code:
  - `src/App.tsx`
  - `src/components/notes/NotesModal.tsx`
  - `src/components/products/StockCheckPage.tsx`
  - `src/components/products/ProductsPage.tsx`
  - `src/services/api.ts`
  - `src/types.ts`
  - `src/styles.css`
- Main backend code:
  - `server/app.js`
  - `server/routes/*.routes.js`
  - `server/controllers/*.controller.js`
  - `server/services/*.service.js`
  - `server/services/catalog.service.js`

## Commands

- Install dependencies: `npm install`
- Run dev frontend + API: `npm run dev`
- Frontend only: `npm run dev:web`
- API only: `npm run dev:api`
- Type check: `npm run check`
- Build: `npm run build`
- Test/syntax check suite: `npm test`

Before committing code changes, run at least `npm run check`. For frontend or API
behavior changes, prefer `npm run build` and `npm test` as well.

## Environment Variables

Use `.env.example` as the source of truth for required variables. Do not commit
real secrets.

Important env vars:

- `DATABASE_URL`: Neon database connection string.
- `SKU_NEXUS_BASE_URL`, `SKU_NEXUS_EMAIL`, `SKU_NEXUS_PASSWORD`: SKU Nexus API.
- `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_API_VERSION`: shared Shopify config. The
  store domain must be the `.myshopify.com` domain, not the admin URL.
- `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`: Shopify order resolve
  integration.
- `SHOPIFY_CLIENT_ID2`, `SHOPIFY_CLIENT_SECRET2`: Shopify product availability
  and quick-ship metafield reads/writes.
- `CRON_SECRET`: bearer token required by Vercel cron endpoints.
- `GMAIL_USER`, `GMAIL_APP_PASSWORD`: Gmail SMTP auth. Use a Gmail app password,
  not the normal account password.
- `GMAIL_FROM_EMAIL`: should be the StockBridge mailbox, currently expected to be
  `stockcheck@dieselpowerproducts.com`.
- `GMAIL_FROM_NAME`: defaults to `StockBridge`.
- `GMAIL_SMTP_HOST`, `GMAIL_SMTP_PORT`, `GMAIL_SMTP_SECURE`: SMTP settings.
- `GMAIL_IMAP_USER`, `GMAIL_IMAP_APP_PASSWORD`: optional mailbox credentials for
  reading vendor inventory sheet emails. If unset, the importer falls back to
  `GMAIL_USER` and `GMAIL_APP_PASSWORD`.
- `GMAIL_IMAP_HOST`, `GMAIL_IMAP_PORT`, `GMAIL_IMAP_SECURE`: IMAP settings.
- `AUTO_INVENTORY_LOOKBACK_DAYS`: how many days of inbox messages the auto
  inventory cron scans.
- `AUTO_INVENTORY_FAILURE_RECIPIENT`: StockBridge notification recipient for
  auto inventory parser/import failures. Defaults to `cade@dieselpowerproducts.com`.
- `AUTO_INVENTORY_GMAIL_LABEL`: Gmail label to apply to vendor inventory sheet
  emails before archiving them from Inbox. Defaults to `Vendor Inventory`.
- `STOCK_CHECK_GMAIL_LABEL`: Gmail label to apply to matched stock-check vendor
  replies before archiving them from Inbox. Defaults to `Stock Check`.

On Vercel, set env vars in the Vercel project settings for the correct
environment. Redeploy after changing env vars.

## Data And Sync Notes

Catalog data is cached in Neon tables:

- `catalog_products`
- `catalog_product_components`
- `catalog_vendors`
- `catalog_vendor_products`
- `catalog_warehouse_stock`
- `catalog_sync_state`

Vercel cron runs `/api/cron/catalog-warehouse-sync` hourly during the active
warehouse window and `/api/cron/catalog-full-sync` daily. The catalog service
uses `CATALOG_SYNC_TIMEZONE` or `America/Los_Angeles` when deciding sync timing.
Cron handlers require `Authorization: Bearer ${CRON_SECRET}`. Warehouse and full
catalog cron functions have `maxDuration: 180` because warehouse sync can also
verify kit quick-ship state in Shopify.

Do not scrape all of SKU Nexus for a one-off fix unless the user explicitly asks.
Prefer code changes that allow the scheduled cron to correct data later, or use a
targeted product refresh path for a single SKU.

Inactive SKU Nexus products should not show on the site. Product queries filter
`state` to active locally; sync code stores `state`.

The nightly full catalog sync repairs blank vendor SKUs in SKU Nexus before
writing vendor products to the local catalog. It reuses an unambiguous SKU from
another vendor assigned to the same product, removes a product prefix only when
that vendor's existing mappings establish the pattern, and otherwise uses the
full product SKU. Failed repairs remain blank so the next full sync retries them.

Kit quick-ship automation runs after successful warehouse data refreshes:

- Code lives in `server/services/kitQuickShip.service.js`.
- Kit parents are quick ship only when every active child/component SKU has
  enough DPP warehouse stock to build one full kit.
- Duplicate child SKUs inside the same kit are summed before comparing required
  quantity to warehouse stock.
- The sync writes variant metafield `custom.quick_ship` as `number_integer` `1`
  or `0` through Shopify, using the `SHOPIFY_CLIENT_ID2` credential profile.
- Each run reads Shopify's current quick-ship metafields first and only writes
  mismatches. This catches external overwrites instead of trusting only local
  `kit_quick_ship_state.last_pushed_quick_ship`.
- Shopify SKU matching intentionally preserves punctuation such as `+`, `(`, and
  `)`; do not strip SKU punctuation when matching variants.

Shopify Collective inventory is pulled during the nightly full catalog sync:

- Code lives in `server/services/shopifyCollectiveInventory.service.js` and the
  Shopify reader lives in `server/services/shopify.service.js`.
- Active products must have the exact `Shopify Collective` Shopify tag and
  tracked variant inventory to be managed by this sync.
- Shopify inventory is authoritative for managed SKUs. Positive inventory maps
  to `In Stock`; zero inventory with `CONTINUE` maps to `Backorder`; zero
  inventory with `DENY` maps to `Out of Stock`.
- The sync stores the managed SKU state in
  `shopify_collective_inventory_state`, updates existing assigned vendor stock
  in SKU Nexus only when its binary state differs, and supports Collective SKUs
  that have no assigned StockBridge vendor.
- The nightly pass also verifies only the Shopify
  `custom.product_availability` metafield against the inventory-derived state;
  it does not alter follow-up dates or other availability metafields.
- If duplicate Shopify variants share a SKU, quantities are combined. Any
  positive total is in stock, and a zero total is out of stock only when every
  matching variant uses `DENY`.

## Product Availability Rules

Key logic lives in `server/services/catalog.service.js`.

- Product availability combines cached DPP warehouse stock quantity and active
  vendor product quantity. Do not use SKU Nexus product-level `qty_available` as
  the availability source when warehouse stock rows are available separately.
- A product with no active vendor can still map to `Available` when quantity is
  zero. This is intentional for products without vendor assignments.
- Built-to-order vendors make unavailable products show `Built to Order`.
- A saved Shopify availability state from `product_shopify_availability_state`
  can mark unavailable products as `Backorder`, `Built to Order`, or
  `Out of Stock`; stale saved `in_stock` is ignored when StockBridge does not
  show real stock.
- Products with saved built-to-order lead times automatically become
  `Built to Order` when they lose stock, even without a built-to-order vendor.
- A built-to-order vendor can be manually overridden to `Backorder` for products
  that are delayed beyond the normal build time.
- Stock Check shows products with a built-to-order vendor only when they have a
  follow-up date. Button-only/manual BTO products are not subject to that vendor
  exclusion.
- Stock Check excludes kit parent products; child/component products can still
  show when their own availability or follow-up state qualifies.
- Stock Check has date filters for yesterday/today/tomorrow plus a "No follow up"
  filter that shows qualifying rows without a follow-up date.
- Kits calculate availability from component availability. Components without a
  vendor assignment should not force the kit to backorder.
- The Notes modal must keep the product table and Stock Check table in sync after
  vendor stock changes and after loading fresh product details. Vendor stock
  changes call a targeted product refresh before emitting `onProductStockChanged`.
- Follow-up date saves also emit `onProductStockChanged` with the new
  `followUpDate`; Stock Check applies that immediately and removes rows that no
  longer match the active filter while the server refresh is loading.
- Stock Check must re-apply its active filter after overlaying local
  `productStockUpdate` data on freshly loaded server results; otherwise a row can
  remain in Yesterday/Today/Tomorrow after its follow-up date changed.
- `App` keeps a per-SKU follow-up override map for the current browser session so
  stale stock-check cache responses cannot reintroduce older follow-up dates for
  recently edited rows.
- Stock Check sends `bypassCache=1` after local refreshes/follow-up edits so the
  API skips `stockCheckCache` and reads current follow-up data from Neon.
- Keep `App`'s `onProductStockChanged` handler stable with `useCallback`; the
  Notes modal's details loader depends on it, so changing the callback identity
  can cause repeated vendor reloads/flicker.
- Successful follow-up and No ETA saves emit a dedicated inventory-audit
  resolution event. Keep this separate from general product stock updates so
  the Audit queue removes the SKU immediately and unrelated modal refreshes
  cannot replace the event.

When changing availability behavior, check:

- `mapAvailability`
- `getEffectiveQtyAvailable`
- `getEffectiveAvailability`
- `mapProduct`
- `getProductDetails`
- `listStockCheckProducts`
- `src/components/notes/NotesModal.tsx`
- `src/components/products/productStockUpdates.ts`
- `server/services/shopify.service.js`
- `server/services/shopifyAvailabilityState.service.js`

## Shopify Availability Metafields

StockBridge writes Shopify availability data to variant metafields through
GraphQL:

- `custom.product_availability` (`single_line_text_field`) uses these exact
  values: `In Stock`, `Out of Stock`, `Backorder`, and `Built to Order`.
- `custom.product_availability_date` (`date_time`) is set from the product
  follow-up date when relevant.
- `custom.availability_date_confirmed` (`boolean`) is `true` for backorder dates
  and `false` for out-of-stock dates.
- `custom.build_to_order_message` (`single_line_text_field`) uses
  `This product will ship in {lead time} from the manufacturer`.
- `custom.quick_ship` (`number_integer`) is managed for kit parents as part of
  warehouse sync.

Availability button rules:

- Before any StockBridge availability write, read Shopify's current
  `custom.product_availability` value. If any matching variant is set to
  `Discontinued` (case-insensitive), do not change its availability metafields,
  BTO message, availability date fields, or inventory policy. This applies to
  buttons, queued updates, Shopify Collective sync, and nightly reconciliation;
  the discontinued value is managed manually in Shopify.

- `In Stock` enables vendor stock and clears availability date, confirmed, and
  BTO message metafields.
- `Backordered` removes vendor stock, pushes the follow-up date if the product
  is not marked No ETA, sets date confirmed to `true`, and is blocked if DPP
  warehouse stock exists.
- `Out of Stock` removes vendor stock, pushes the follow-up date when present,
  sets date confirmed to `false`, removes the BTO message, and sets Shopify
  variant inventory policy to `DENY`.
- `Built to Order` opens the lead-time field without changing vendor stock. It
  can update Shopify only when the product has at least one assigned vendor and
  every assigned vendor and warehouse source is out of stock; qualifying writes
  clear availability date and date confirmed and write the BTO message when a
  lead time exists.
- Shopify pushes from follow-up, inventory, and BTO lead-time edits are debounced
  through the database-backed `shopify_availability_sync_queue`. Each new change
  resets that SKU's 30-second quiet period and publishes a delayed Vercel Queue
  message. Vercel invokes the push consumer when a message is ready; there is no
  polling cron. The authenticated cron-style endpoint remains available for
  manual recovery. Closing the Notes modal does not cancel the update.
  Button clicks update the local UI state immediately, perform their explicit
  Shopify push, and clear any redundant queued update.
- The nightly full catalog sync queues reconciliation for active products whose
  saved Shopify state is not in stock, recently changed in-stock products, and
  all products assigned to an active built-to-order vendor. Including BTO-vendor
  products catches stale or missing saved states after inventory loss without
  scanning every in-stock Shopify variant each night.

There is a utility page at `#/shopify-availability-sync` for pulling current
Shopify availability metafields back into StockBridge local state. It scans
Shopify variants in pages of up to 250 and records skipped/conflicting SKUs.

## Stock Check Behavior

Stock Check is backed by `GET /products/stock-check`.

- It shows backordered products and products with follow-up dates.
- It hides kit parent products.
- It hides built-to-order vendor products when they do not have a follow-up
  date, and shows them when a follow-up date is present.
- Date-filter pagination must be based on the filtered result set for
  yesterday/today/tomorrow, not the unfiltered all-results count.
- It can show an email icon next to SKUs that have had a vendor stock-check email
  sent.
- The email icon is cleared when the product follow-up date is updated.

Related services:

- `server/services/stockCheckEmails.service.js`
- `server/services/followUps.service.js`
- `server/services/products.service.js`

## Notes Modal

The Notes modal is the main operational UI for a product.

It includes:

- Notes and mentions.
- Follow-up date controls.
- A No ETA checkbox. When checked for a backordered product, Shopify availability
  still gets `Backorder`, but no availability date is pushed.
- Shopify availability buttons for `In Stock`, `Out of Stock`, `Backordered`,
  and `Built to Order`, with the active state shown by button color.
- Built-to-order lead time storage. If no BTO vendor supplies a build time, the
  modal stores the entered lead time per SKU and rehydrates it when reopened.
  The lead-time box stays visible while the product is in BTO state.
- Vendor stock on/off controls.
- Non-warehouse vendor rows include a pencil menu for viewing and editing the
  SKU Nexus vendor SKU and product cost cached in `catalog_vendor_products`.
  Saves update SKU Nexus first, then update the local cache without changing
  inventory or vendor-product status.
- Auto-inventory-managed vendor stock rows are read-only. Numerical rows show
  `Qty`; alphabetical rows show `In Stock` or `Out of Stock`. Both include the
  latest sheet update time in their hover title.
- Kit/component modal. Kit parent products show child components; child products
  that belong to kits show a "Kit Component" button with parent kits.
- Vendor stock-check email composer.

The modal exists both as an in-app modal and as a route/popup view. Make sure
changes work in both uses. The notes route is `#/notes/:sku`, and the Vendors
tab opens the same modal from product SKU links.

## Vendor Email Feature

Vendor email code is split across:

- Frontend: `src/components/notes/NotesModal.tsx`
- API client: `src/services/api.ts`
- Routes/controller: `server/routes/email.routes.js`,
  `server/controllers/email.controller.js`
- SMTP: `server/services/email.service.js`
- Templates: `server/services/emailTemplates.service.js`
- Vendor contacts/defaults:
  - `server/services/vendors.service.js`
  - `server/services/vendorDefaultContacts.service.js`
  - `server/routes/vendors.routes.js`
  - `server/controllers/vendors.controller.js`

Vendor contacts are pulled from SKU Nexus `vendorContact`. Always filter out
`shipping@dieselpowerproducts.com`.

Email templates support `{SKU}` replacement in subject and body.

Default vendor contacts are stored in `vendor_default_contacts`. The contacts
endpoint annotates contacts with `isDefault`; the email composer auto-selects
the default contact and shows a "Default contact" badge.

Vendor stock-check replies are reduced to their operational content before
appearing in Inventory Audit. The parser removes quoted threads, greetings,
signatures, contact details, legal disclaimers, inline-image placeholders, and
known support-ticket boilerplate. Signature detection includes standalone names
followed by role/contact lines and known branded signature boundaries. Keep the
cleanup deterministic and covered by realistic vendor-format tests; do not add
an external AI dependency for reply parsing. Strip opening greetings before
running name/signature inference so phrases such as "Good Afternoon" cannot be
mistaken for a signer and erase the operational reply.

Sent stock-check emails store the SMTP message ID in
`stock_check_vendor_emails`. Gmail replies are matched to that message ID first,
with a normalized subject/SKU fallback for older sent records. Matched replies
are stored in `inventory_audits` as plain text only; attachments, inline images,
and quoted email history are not stored. Each original stock-check email has one
pending audit; a newer reply in the same thread replaces the displayed response.
Matched replies receive the `Stock Check` Gmail label and are archived from
Inbox. Updating a product follow-up date or No ETA state clears its pending
inventory audits. Inventory Audit also removes the matching SKU from its local
queue immediately after the follow-up save succeeds; do not require a manual
refresh to reflect that deletion.

The sidebar Audit page at `#/audit` has a selector for Price Audit and Inventory
Audit. Price Audit retains the existing confirm/deny workflow. Inventory Audit
shows the product SKU, the vendor from the original stock-check email, and the
vendor's reply. The old `#/price-audit` hash route opens the unified Audit page.

## Vendor Auto Inventory Feature

Vendor auto inventory settings are configured on each vendor page. The button
under the built-to-order controls reads "Add auto inventory" until enabled, then
"Auto inventory settings".

Related code:

- UI: `src/components/vendors/VendorsPage.tsx`,
  `src/components/vendors/VendorProductsTable.tsx`
- Settings table/service: `vendor_auto_inventory_settings`,
  `server/services/vendorAutoInventorySettings.service.js`
- Import history/dedupe: `vendor_auto_inventory_imports`,
  `server/services/vendorAutoInventoryImports.service.js`
- Mailbox/sheet importer: `server/services/autoInventory.service.js`
- Cron: `/api/cron/auto-inventory`

The importer reads inventory sheet attachments from the configured sender email.
It supports CSV and modern Excel workbook formats such as `.xlsx` and `.xlsm`.
It maps the configured SKU header and inventory header. Numerical mode treats
any value above zero as `999999` and zero/blank/unparseable rows are skipped or
set to zero as appropriate. Alphabetical mode uses colon-separated phrases for
in-stock and out-of-stock messages; matching in-stock phrases write `999999`,
out-of-stock phrases write `0`. Commas are tolerated by the parser for
convenience, but the UI should show colon-separated examples.

Sheet-specific parser/import issues appear in the Sheet Imports Pending tab and
must not create StockBridge notifications. These include missing configured
headers, empty/unreadable inventory sheets, unrecognized alphabetical stock
phrases, rows with missing SKUs, and SKU Nexus update errors. Keep unexpected
mailbox or queue runtime failures visible through operational logging.
Sheet Import review cards retain a compact header/sample-row preview and can
open the original attachment from the archived Gmail message. Mapping labels
must make clear that the inventory field controls stock availability, not price.
The optional subtractive column represents allocated/committed stock deducted
from the primary quantity. Keep list-card status synchronized with the selected
detail because Gmail parse/apply jobs can move through retrying states quickly.
Proposal rows describe this vendor's stock state, not the product's aggregated
availability. Show both vendor stock status and the prior-to-proposed sheet
quantity; the highlighted destination is the value that will be recorded.
For pending reviews created before the prior-quantity audit column existed,
backfill from the vendor's tracked auto-inventory quantity, then from the current
SKU Nexus vendor-product quantity. Do not show an unknown prior value when one
of those sources exists.
Vendor sheets often include SKUs DPP does not sell; unmatched vendor SKUs should
be skipped quietly and should not notify as failures.
Numerical and alphabetical auto-inventory updates are stored in
`vendor_auto_inventory_product_updates` and surfaced in product details only for
vendor products actively represented by the latest sheet and not listed in SKU
exceptions. SKU exceptions keep normal manual stock controls. Manual exceptions
remain disabled until a user explicitly re-enables auto inventory. Missing-sheet
exceptions are created from Pending sheet reviews and remove themselves only
when that exact product or vendor SKU appears on a later sheet. Matching accepts
vendor grouping dashes, such as `1039093278` and `103-909-3278`, while retaining
collision checks before assigning a row.
Clean inventory sheets are staged and applied automatically. Pending review is
reserved for parse/mapping errors and active StockBridge vendor products that
cannot be found on the vendor's sheet. Missing assigned SKUs are stored separately
from extra vendor-sheet SKUs, which remain harmless and are skipped quietly.
Adding a missing SKU to the exception list disables auto inventory for that vendor
product. If a later sheet contains the excepted SKU, the importer automatically
removes its exception and resumes auto inventory for it.
Resolving the final missing SKU automatically approves and queues the staged
sheet when no invalid rows remain; users should not need to retry the parser.
Approved and applying sheets leave Pending immediately. If application fails,
the failed audit returns to Pending while retries remain.
Auto-inventory vendor configuration lives on the Sheet Imports Vendors tab, not
on the general Vendors product page. Pending imports show a searchable rendering
of the original spreadsheet beside unresolved missing SKUs; Retry always reparses
the original Gmail attachment.
The importer adds the Gmail label configured by `AUTO_INVENTORY_GMAIL_LABEL` to
all matching vendor emails with inventory sheet attachments found during the
cron run, then archives them from Inbox by moving them to Gmail's All Mail
mailbox so they live under that Gmail label. If multiple matching emails from
the same configured sender are present during one cron run, only the newest
email is imported for that vendor.

Vendor inventory sheets are staged for review instead of changing SKU Nexus as
soon as Gmail receives them. The separate sidebar page at `#/sheet-imports`
shows pending sheets, row-level current/proposed availability, missing-header
column mapping, and summary-level history from imports that predate the review
workflow. Approving a staged sheet publishes a durable queue job that applies
only its proposed inventory changes. Failed parsing or apply jobs can be
retried manually from the page at most three times; queue delivery itself stops
after five processing attempts. Rejecting a sheet is terminal and writes no
inventory changes.
Column mapping is stored on each sheet-import card. Reviewers can optionally
save that mapping as the vendor default for future sheets; a vendor can therefore
send multiple layouts without overwriting its default every time. Proposed
changed rows are included by default and can be removed or restored individually
before approval. Approval applies only the selected rows and retains excluded
rows in the card history for traceability.

## UI Guidance

Keep the app operational and dense rather than marketing-like. It is a work tool.

- Match the existing dark UI.
- Keep controls compact and readable.
- Avoid layout shifts in tables and modal controls.
- For icon buttons, use existing inline SVG style unless the app adopts an icon
  library later.
- Keep dropdowns dark; native select options are styled in `src/styles.css`.

## Coding Conventions

- Prefer existing service/controller/route patterns.
- Keep changes scoped.
- Do not commit generated logs or secrets.
- Use TypeScript types from `src/types.ts`.
- Use server services for persistence and external API logic; controllers should
  stay thin.
- New database-backed services should create their own table lazily with
  `CREATE TABLE IF NOT EXISTS`, following existing services.
- When adding a server service, add it to the `npm test` syntax/require checks if
  appropriate.

## Git Workflow

- Check `git status --short --branch` before edits and before commits.
- Do not revert unrelated user changes.
- Push completed updates to `main` immediately unless the user explicitly asks
  to hold them for review or not push. Commit intentionally and push
  `origin main`.
- Good commit messages are short and specific, for example:
  - `Add default vendor contact selection`
  - `Refresh product after vendor stock changes`

## Recent Important Decisions

- Gmail should use an app password.
- Gmail Reply-To is set to `GMAIL_FROM_EMAIL` so replies go back to the StockBridge
  mailbox rather than another authenticated account.
- SKU Nexus inactive products are hidden via code and should be corrected by cron
  over time.
- Vendor stock changes in Notes should refresh the single SKU before updating the
  table to avoid stale availability.
- Warehouse sync also verifies Shopify quick-ship for active kit parents, so a
  Shopify `quick_ship=1` parent that can no longer be fulfilled from DPP
  warehouse stock should be changed back to `0`.
- Do not normalize Shopify SKUs by removing punctuation; exact SKU punctuation is
  required for variants such as `BDS-55371+98224016(x2)`.
