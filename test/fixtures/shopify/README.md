# Shopify fixtures

There are two kinds of fixture here. **Know which you are looking at.**

| Where | What | Status |
|---|---|---|
| `real/` | REAL `orders/paid` deliveries captured from the dev app (test orders #1015 to #1018, USD), redacted by `scripts/export-webhook-payloads.mjs` on 2026-10-08 (every key kept, personal and secret values replaced). Each file's `_provenance` header says so. | **Real.** Use these for anything about the `orders/paid` shape. |
| top level (`orders-paid-*.json`, `refunds-create-money-only.json`, `orders-cancelled-rest-get.json`) | Hand-built (or stripped and rewritten) payloads. | **All six are SUPERSEDED by `real/`** and kept only for history (never edited): the four `orders-paid-*` by the real orders, `refunds-create-money-only.json` by `refunds-create-1020-r4-money-only.json`, and `orders-cancelled-rest-get.json` by `orders-cancelled-1021.json`. Use `real/`. |

## Real captures (`real/`)

| File | Order | What it exercises |
|---|---|---|
| `orders-paid-1015-plain.json` | #1015 | one line 600.00, no discount, no tax |
| `orders-paid-1016-discount.json` | #1016 | one line 749.95, a 10% discount code (allocation 74.99) |
| `orders-paid-1017-giftcard-discount.json` | #1017 | a 749.95 line plus a 10.00 gift card; the 10% code touched only the first line |
| `orders-paid-1018-tax-included.json` | #1018 | one line 712.45 with 108.68 tax included (one tax line), shipping 30.00 |

`test/loyalty/real-fixtures.test.js` feeds each through `storeWebhook` and `processPendingWebhooks`, overriding only the order id and `customer.id` (earn keys are global and ledger rows are immutable), and asserts 60000/600, 67496/674, 67496/674 and 60377/603.

### Real refunds and cancellation (captured 2026-10-09, test orders #1019 to #1021)

| File | Order | What it exercises |
|---|---|---|
| `refunds-create-1019-r1-restock.json` | #1019 (2 units of one line, 1349.91 paid after a 149.99 discount) | R1: one unit, `restock_type: "cancel"`, subtotal 674.95 |
| `refunds-create-1019-r2-no-restock.json` | #1019 | R2: the other unit, `restock_type: "no_restock"`, subtotal 674.96 |
| `refunds-create-1020-r3-giftcard.json` | #1020 (749.95 line plus a 10.00 gift card) | R3: refund of the gift-card line (`line_item.gift_card: true`), 10.00 |
| `refunds-create-1020-r4-money-only.json` | #1020 | R4: money-only 20.00: `refund_line_items: []`, one `order_adjustments` entry |
| `refunds-create-1021-r5-cancel.json` | #1021 (one line, 749.95) | R5: full refund created by cancelling the order, `restock_type: "cancel"` |
| `orders-cancelled-1021.json` | #1021 | the `orders/cancelled` delivery for the same cancel |

These six were exported through the wrapper and redacted with `web/lib/redact-payload.js` as of 2026-10-09, which now also masks `user_id`, `transactions[].authorization`, `transactions[].message` and the whole `transactions[].receipt` subtree (keys kept). Each file's `_provenance` header says so. The audit of leftover paths (paths only, never values) listed only `source_name` (a numeric id), product and location names ("The Collection Snowboard: Liquid", "Shop location") and `payment_gateway_names` (`bogus`): none personal.

### VERIFIED by the real refund and cancel captures
- **`refunds/create` shape:** top-level keys `id`, `note`, `duties`, `restock`, `user_id`, `order_id`, `created_at`, `processed_at`, `transactions`, `total_duties_set`, `order_adjustments`, `refund_line_items`, `admin_graphql_api_id`, `refund_shipping_lines` (plus `return` on the webhook, absent from the copy embedded in `orders/cancelled`).
- **`refund_line_items[]` entry:** `id`, `quantity`, `line_item_id` (equals `line_item.id`), `location_id`, `restock_type` (`cancel` or `no_restock`), `subtotal` (a JSON **number**, not a string), `subtotal_set`, `total_tax` (number), `total_tax_set`, and `line_item`, a full snapshot of the order line including `gift_card`, `quantity` (the ORIGINAL line quantity), `price`, `discount_allocations`, `tax_lines`.
- **Partial refunds of a discounted line:** `subtotal` is the discounted amount for the refunded units. Two single-unit refunds of the 2-unit line in #1019 carry 674.95 and 674.96, which add to the 1349.91 paid. Shopify rounds one up and one down; the two are not equal.
- **Money-only refund:** `refund_line_items` is empty, `transactions[0].amount` is the money, and `order_adjustments[]` has one entry (`kind: "refund_discrepancy"`, negative `amount`, `refund_id`, `reason`, `tax_amount`).
- **Refund of a gift-card line:** the entry's `line_item.gift_card` is `true`.
- **Transactions:** `kind: "refund"`, `amount` string, `status`, `gateway: "bogus"` (test gateway), `parent_id`, `currency`, `test: true`.
- **Cancel:** cancelling #1021 created refund R5 and, 39 ms later (`receivedAt` 04:09:53.885 vs 04:09:53.924), the `orders/cancelled` delivery. The cancelled body is a complete order (`cancelled_at`, `cancel_reason: "other"`, `financial_status: "refunded"`) whose `refunds[]` already contains R5 (same refund id), so the two describe the same refund and may be processed in either order.
- **A live `orders/cancelled` delivery:** captured, no longer "unverified".

### VERIFIED by these real captures (`orders/paid`)
- **Tax line (single entry on a line):** keys `rate` (float), `price` (string), `title` (string), `price_set` (object), `channel_liable` (boolean). The amount is under **`price`**; there is **no `amount` key**. The same entry appears at order level in `tax_lines`. (#1018)
- **`discount_allocations` entry:** `amount` (string), `amount_set` (object), `discount_application_index` (integer). (#1016, #1017)
- **`discount_applications` and `discount_codes` entries:** `code`, `type`, `value`, `value_type`, `target_type`, `target_selection`, `allocation_method`; and `code`, `type`, `amount`. (#1016, #1017)
- **Gift-card line:** `gift_card: true`, its `price`, `discount_allocations: []`, no tax lines, `taxable: false`. With a percentage code on the whole order the discount was allocated only to the non-gift-card line (74.99 = 10% of 749.95, not of 759.95). (#1017)
- Line `price` is a decimal string equal to `price_set.shop_money.amount`; `shipping_lines[].price` and `discounted_price` are decimal strings; `processed_at` is ISO 8601 with a UTC offset (here `-04:00`); `taxes_included` is a boolean; `customer.id` and `product_id` are numbers.
- The customer object carries `id` and non-identifying fields only (no name, email or phone), and `billing_address` / `shipping_address` carry only country and province. That is what an app without protected-customer-data access receives.
- Line-item `total_discount` is `"0.00"` even where a discount allocation exists; the allocations are the reliable source.

### STILL UNVERIFIED (no real capture yet)
- **More than one tax line on a single line item** (for example CGST and SGST). The code sums them (`price`, falling back to `amount`), and unit tests cover it, but Shopify has not been seen sending it.
- **Partial refunds of a taxed line on a tax-inclusive order** (`refund_line_items[].total_tax` non-zero). All captured refunds are on untaxed lines.
- **Any non-USD order or refund** (the real stores are INR). All captures are USD with `currency` equal to `presentment_currency` and `shop_money` equal to `presentment_money`; the shop-money versus presentment-money choice has not been exercised.
- **The returns flow** (`returns/*` topics, and a `refunds/create` generated from a return; the `return` key is `null` on every capture).
- Guest orders (no customer).

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
| `refunds-create-money-only.json` | _note_: "Shopify refunds/create — money-only refund (no line items). refund_line_items:[] confirms this reverses no points. Captured from platinum-ecofynd-test-store. Real emails/names removed."<br>_captured_: "Earlier session (pre-phase1)"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `(none)` | **SUPERSEDED by `real/refunds-create-1020-r4-money-only.json`.** Hand-built. Ids 1100000001 / 2001 / 1, `created_at` exactly 10:00:00+05:30, refers to the hand-built order 5678901234567. Has no `processed_at`, and is much thinner than a real `refunds/create` body (which typically also carries fields such as `note`, `user_id`, `restock`, `duties`; verify against a real capture). The "money-only refunds reverse no points" conclusion (J6) was reached from this file. |
| `orders-cancelled-rest-get.json` | _note_: "Shopify orders/cancelled payload. Source: REST GET /orders/{id}.json — NOT a live webhook delivery (live orders/cancelled webhook pending, to be triggered once the dev app subscribes — T2.2). Real emails/names removed."<br>_captured_: "Phase 1 prep session via REST GET"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | **SUPERSEDED by `real/orders-cancelled-1021.json`.** Hand-built, and by its own note not a webhook: a REST `GET /orders/{id}` shape, so it cannot prove the `orders/cancelled` webhook payload. Order #1005, one line "Cancelled Product". Missing the same order and line keys. T2.2 requires one live `orders/cancelled` delivery. |

## Tax lines

The single-tax-line shape is **VERIFIED** by real capture #1018 (see above): amount under `price`, plus `rate`, `title`, `price_set`, `channel_liable`; no `amount` key.

- The earning code (`web/loyalty/rules/earning.js`, `taxLineAmountPaise`) reads `price`, falling back to `amount` (the field the hand-made fixtures used), sums all tax lines on a line, and throws, listing key names and no values, if a line being stripped has neither.
- **Still UNVERIFIED:** several tax lines on one line item (CGST/SGST), and any non-USD taxed order. `test/loyalty/earning.test.js` covers two lines with synthetic entries, and `test/loyalty/tax-pipeline.test.js` uses a payload derived from real order #1015 with `price` and `tax_lines` edited by hand; both are marked as such and neither is evidence of what Shopify sends for those cases.

## What is left to capture

1. Capture real bodies from the dev app with `scripts/export-webhook-payloads.mjs` (redacted; review the output by eye before committing): an order with two tax lines (CGST and SGST), a non-USD order, a partial refund of a taxed line on a tax-inclusive order, and a return.
2. T2.2 ("adapters built on real fixtures") is **done for `orders/paid`, `refunds/create` and `orders/cancelled`**.
