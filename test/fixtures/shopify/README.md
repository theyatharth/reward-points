# Shopify fixtures

There are two kinds of fixture here. **Know which you are looking at.**

| Where | What | Status |
|---|---|---|
| `real/` | REAL `orders/paid` deliveries captured from the dev app (test orders #1015 to #1018, USD), redacted by `scripts/export-webhook-payloads.mjs` on 2026-10-08 (every key kept, personal and secret values replaced). Each file's `_provenance` header says so. | **Real.** Use these for anything about the `orders/paid` shape. |
| top level (`orders-paid-*.json`, `refunds-create-money-only.json`, `orders-cancelled-rest-get.json`) | Hand-built (or stripped and rewritten) payloads. | **The four `orders-paid-*` are SUPERSEDED by `real/`** and kept only for history. The refund and cancelled fixtures are NOT superseded: there is no real capture of either, so they remain the only fixtures of their kind and remain **unverified**. |

## Real captures (`real/`)

| File | Order | What it exercises |
|---|---|---|
| `orders-paid-1015-plain.json` | #1015 | one line 600.00, no discount, no tax |
| `orders-paid-1016-discount.json` | #1016 | one line 749.95, a 10% discount code (allocation 74.99) |
| `orders-paid-1017-giftcard-discount.json` | #1017 | a 749.95 line plus a 10.00 gift card; the 10% code touched only the first line |
| `orders-paid-1018-tax-included.json` | #1018 | one line 712.45 with 108.68 tax included (one tax line), shipping 30.00 |

`test/loyalty/real-fixtures.test.js` feeds each through `storeWebhook` and `processPendingWebhooks`, overriding only the order id and `customer.id` (earn keys are global and ledger rows are immutable), and asserts 60000/600, 67496/674, 67496/674 and 60377/603.

### VERIFIED by these real captures
- **Tax line (single entry on a line):** keys `rate` (float), `price` (string), `title` (string), `price_set` (object), `channel_liable` (boolean). The amount is under **`price`**; there is **no `amount` key**. The same entry appears at order level in `tax_lines`. (#1018)
- **`discount_allocations` entry:** `amount` (string), `amount_set` (object), `discount_application_index` (integer). (#1016, #1017)
- **`discount_applications` and `discount_codes` entries:** `code`, `type`, `value`, `value_type`, `target_type`, `target_selection`, `allocation_method`; and `code`, `type`, `amount`. (#1016, #1017)
- **Gift-card line:** `gift_card: true`, its `price`, `discount_allocations: []`, no tax lines, `taxable: false`. With a percentage code on the whole order the discount was allocated only to the non-gift-card line (74.99 = 10% of 749.95, not of 759.95). (#1017)
- Line `price` is a decimal string equal to `price_set.shop_money.amount`; `shipping_lines[].price` and `discounted_price` are decimal strings; `processed_at` is ISO 8601 with a UTC offset (here `-04:00`); `taxes_included` is a boolean; `customer.id` and `product_id` are numbers.
- The customer object carries `id` and non-identifying fields only (no name, email or phone), and `billing_address` / `shipping_address` carry only country and province. That is what an app without protected-customer-data access receives.
- Line-item `total_discount` is `"0.00"` even where a discount allocation exists; the allocations are the reliable source.

### STILL UNVERIFIED (no real capture yet)
- **More than one tax line on a single line item** (for example CGST and SGST). The code sums them (`price`, falling back to `amount`), and unit tests cover it, but Shopify has not been seen sending it.
- **Refund payloads.** `refunds/create` with line items, partial refunds, and money-only refunds. The only refund fixture is hand-built.
- **Any non-USD order** (the real stores are INR). All four captures are USD with `currency` equal to `presentment_currency` and `shop_money` equal to `presentment_money`; the shop-money versus presentment-money choice has not been exercised.
- A live `orders/cancelled` delivery, and guest orders (no customer).

## Evidence that the top-level fixtures are hand-built

- **Sequential ids.** The four `orders-paid-*` fixtures have order ids 5678901234567 to 5678901234570 and names `#1001` to `#1004`; the cancelled fixture continues the run (5678901234571, `#1005`). The money-only refund (id 1100000001, transaction 2001, adjustment 1) refers to the first of them (5678901234567). On the `orders-paid-*` fixtures the line item ids are 1001 to 1005.
- **Placeholder content.** Product titles are "Test Product", "GST Product", "Discounted Product", "Physical Product", "Gift Card", "Cancelled Product". `sku`, `product_id` and `variant_id` are absent.
- **One customer for everything.** Every order has customer id 9001 and only the keys `id` and `admin_graphql_api_id`.
- **Round timestamps.** `processed_at` is exactly `10:00:00+05:30` on 20, 22, 23 and 24 September 2026; the refund's `created_at` is exactly `2026-09-21T10:00:00+05:30`.
- **Far fewer keys than a real payload.** 16 to 17 top-level keys on each `orders-paid-*` (a real `orders/paid` body carries many more; roughly a hundred, from Shopify's documentation as recalled, so verify against a real capture); 19 on the cancelled one.
- **The claimed currency is not in the payload.** The files say `_currency: USD` but contain no `currency` or `presentment_currency` field at all.

## What the top-level order fixtures are missing compared with a real `orders/paid` payload (now measured against `real/`)

Missing order-level keys (checked against the keys a real order always carries): `subtotal_price`, `total_price`, `total_tax`, `total_discounts`, `total_line_items_price`, `currency`, `presentment_currency`, `current_total_price`, all `*_set` money objects, `created_at`, `updated_at`, `order_number`, `token`, `confirmation_number`, `test`, `email`, `payment_gateway_names`, `tax_lines`.

Missing line-item keys (absent from every line): `variant_id`, `product_id`, `sku`, `name`, `price_set`, `grams`, `vendor`, `taxable`, `requires_shipping`, `fulfillment_status`, `total_discount`, `properties`, `admin_graphql_api_id`.

Because `subtotal_price`, `total_price` and every `*_set` object are absent, nothing here can check the adapter's choice of source field for money amounts (`shop_money` versus presentment money), nor its handling of `taxes_included` against a real `total_tax`.

## Top-level fixtures: what each claims, what it is

| Fixture | What its `_note` / `_captured` claims | Finding |
|---|---|---|
| `orders-paid-no-discount-no-tax.json` | _note_: "Shopify orders/paid webhook payload — no discount, no tax. Captured from platinum-ecofynd-test-store. Real emails/names removed."<br>_captured_: "Earlier session (pre-phase1)"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | **SUPERSEDED by `real/`.** Hand-built. Order #1001, one line "Test Product", no `sku`/`product_id`, 16 top-level keys, `processed_at` exactly 10:00:00+05:30. Missing the order and line keys listed above. |
| `orders-paid-gst-taxes-included.json` | _note_: "Shopify orders/paid with 18% GST included (taxes_included:true). USD store, but tax-line mechanism is currency-neutral. Real emails/names removed. Used for T1.5 GST arithmetic test."<br>_captured_: "Phase 1 prep session"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | **SUPERSEDED by `real/`.** Hand-built. Order #1002, one line "GST Product", `taxes_included: true` with a hand-written tax line. Missing the keys above, including `total_tax`, `currency` and `tax_lines`. It proves the tax-line *arithmetic*; it says nothing about INR (and has no currency field). |
| `orders-paid-10pct-discount.json` | _note_: "Shopify orders/paid with 10% discount across all lines. discount_allocations shows the allocation per line. Real emails/names removed. Confirms J4: discount allocations touch only non-gift-card lines."<br>_captured_: "Phase 1 prep session"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | **SUPERSEDED by `real/`.** Hand-built. Order #1003, one line "Discounted Product", one hand-written `discount_allocations` entry on the line. Missing the keys above, including `total_discounts` and any `*_set`. |
| `orders-paid-gift-card-with-discount.json` | _note_: "Shopify orders/paid with a gift card + discount. KEY FINDING (J4): discount_allocations is EMPTY on the gift-card line even though target_selection:'all'. The client's prototype test (619 pts) is wrong for real orders; real fixture asserts 559 pts. Real emails/names removed."<br>_captured_: "Phase 1 prep session"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | **SUPERSEDED by `real/`.** Hand-built. Order #1004, lines "Physical Product" (499.00) and "Gift Card" (110.00, `gift_card: true`, no `discount_allocations`). The J4 finding rests on this file, so it needs a real capture before it is relied on. Missing the keys above. |
| `refunds-create-money-only.json` | _note_: "Shopify refunds/create — money-only refund (no line items). refund_line_items:[] confirms this reverses no points. Captured from platinum-ecofynd-test-store. Real emails/names removed."<br>_captured_: "Earlier session (pre-phase1)"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `(none)` | **NOT superseded (no real capture exists).** Hand-built. Ids 1100000001 / 2001 / 1, `created_at` exactly 10:00:00+05:30, refers to the hand-built order 5678901234567. Has no `processed_at`, and is much thinner than a real `refunds/create` body (which typically also carries fields such as `note`, `user_id`, `restock`, `duties`; verify against a real capture). The "money-only refunds reverse no points" conclusion (J6) was reached from this file. |
| `orders-cancelled-rest-get.json` | _note_: "Shopify orders/cancelled payload. Source: REST GET /orders/{id}.json — NOT a live webhook delivery (live orders/cancelled webhook pending, to be triggered once the dev app subscribes — T2.2). Real emails/names removed."<br>_captured_: "Phase 1 prep session via REST GET"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | **NOT superseded (no real capture exists).** Hand-built, and by its own note not a webhook: a REST `GET /orders/{id}` shape, so it cannot prove the `orders/cancelled` webhook payload. Order #1005, one line "Cancelled Product". Missing the same order and line keys. T2.2 requires one live `orders/cancelled` delivery. |

## Tax lines

The single-tax-line shape is **VERIFIED** by real capture #1018 (see above): amount under `price`, plus `rate`, `title`, `price_set`, `channel_liable`; no `amount` key.

- The earning code (`web/loyalty/rules/earning.js`, `taxLineAmountPaise`) reads `price`, falling back to `amount` (the field the hand-made fixtures used), sums all tax lines on a line, and throws, listing key names and no values, if a line being stripped has neither.
- **Still UNVERIFIED:** several tax lines on one line item (CGST/SGST), and any non-USD taxed order. `test/loyalty/earning.test.js` covers two lines with synthetic entries, and `test/loyalty/tax-pipeline.test.js` uses a payload derived from real order #1015 with `price` and `tax_lines` edited by hand; both are marked as such and neither is evidence of what Shopify sends for those cases.

## What is left to capture

1. Capture real bodies from the dev app with `scripts/export-webhook-payloads.mjs` (redacted; review the output by eye before committing): an order with two tax lines (CGST and SGST), a non-USD order, `refunds/create` (partial, full, money-only), and a live `orders/cancelled`.
2. Replace the corresponding hand-built top-level fixtures, update their `_note`, and re-run the adapter and earning tests. Expect some tests to need new expected values; that is the purpose of the exercise.
3. T2.2 ("adapters built on real fixtures") is **done for `orders/paid`** and **open for refunds and cancellations**.
