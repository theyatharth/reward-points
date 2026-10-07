# Shopify fixtures: read this before trusting them

**Every file in this directory is hand-built (or a stripped and rewritten payload). None is a raw capture of a Shopify webhook delivery, whatever its `_note` says.** They are fit for unit-testing the arithmetic in the rules modules, not for proving that the adapters parse real Shopify payloads.

**These must be replaced by real captures before T2.2 (adapters built on real fixtures) is called done.** Until then, any test that reads a fixture here proves the code handles *this* shape, not what Shopify actually sends.

No fixture file has been edited to produce this note. The `_note`, `_captured`, `_store` and `_currency` fields below are quoted from the files themselves.

## Evidence that they are hand-built

- **Sequential ids.** The four `orders-paid-*` fixtures have order ids 5678901234567 to 5678901234570 and names `#1001` to `#1004`; the cancelled fixture continues the run (5678901234571, `#1005`). The money-only refund (id 1100000001, transaction 2001, adjustment 1) refers to the first of them (5678901234567). On the `orders-paid-*` fixtures the line item ids are 1001 to 1005.
- **Placeholder content.** Product titles are "Test Product", "GST Product", "Discounted Product", "Physical Product", "Gift Card", "Cancelled Product". `sku`, `product_id` and `variant_id` are absent.
- **One customer for everything.** Every order has customer id 9001 and only the keys `id` and `admin_graphql_api_id`.
- **Round timestamps.** `processed_at` is exactly `10:00:00+05:30` on 20, 22, 23 and 24 September 2026; the refund's `created_at` is exactly `2026-09-21T10:00:00+05:30`.
- **Far fewer keys than a real payload.** 16 to 17 top-level keys on each `orders-paid-*` (a real `orders/paid` body carries many more; roughly a hundred, from Shopify's documentation as recalled, so verify against a real capture); 19 on the cancelled one.
- **The claimed currency is not in the payload.** The files say `_currency: USD` but contain no `currency` or `presentment_currency` field at all.

## What each order fixture is missing compared with a real `orders/paid` payload

Missing order-level keys (checked against the keys a real order always carries): `subtotal_price`, `total_price`, `total_tax`, `total_discounts`, `total_line_items_price`, `currency`, `presentment_currency`, `current_total_price`, all `*_set` money objects, `created_at`, `updated_at`, `order_number`, `token`, `confirmation_number`, `test`, `email`, `payment_gateway_names`, `tax_lines`.

Missing line-item keys (absent from every line): `variant_id`, `product_id`, `sku`, `name`, `price_set`, `grams`, `vendor`, `taxable`, `requires_shipping`, `fulfillment_status`, `total_discount`, `properties`, `admin_graphql_api_id`.

Because `subtotal_price`, `total_price` and every `*_set` object are absent, nothing here can check the adapter's choice of source field for money amounts (`shop_money` versus presentment money), nor its handling of `taxes_included` against a real `total_tax`.

## Per fixture: what it claims, what it is

| Fixture | What its `_note` / `_captured` claims | Finding |
|---|---|---|
| `orders-paid-no-discount-no-tax.json` | _note_: "Shopify orders/paid webhook payload — no discount, no tax. Captured from platinum-ecofynd-test-store. Real emails/names removed."<br>_captured_: "Earlier session (pre-phase1)"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | Hand-built. Order #1001, one line "Test Product", no `sku`/`product_id`, 16 top-level keys, `processed_at` exactly 10:00:00+05:30. Missing the order and line keys listed above. |
| `orders-paid-gst-taxes-included.json` | _note_: "Shopify orders/paid with 18% GST included (taxes_included:true). USD store, but tax-line mechanism is currency-neutral. Real emails/names removed. Used for T1.5 GST arithmetic test."<br>_captured_: "Phase 1 prep session"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | Hand-built. Order #1002, one line "GST Product", `taxes_included: true` with a hand-written tax line. Missing the keys above, including `total_tax`, `currency` and `tax_lines`. It proves the tax-line *arithmetic*; it says nothing about INR (and has no currency field). |
| `orders-paid-10pct-discount.json` | _note_: "Shopify orders/paid with 10% discount across all lines. discount_allocations shows the allocation per line. Real emails/names removed. Confirms J4: discount allocations touch only non-gift-card lines."<br>_captured_: "Phase 1 prep session"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | Hand-built. Order #1003, one line "Discounted Product", one hand-written `discount_allocations` entry on the line. Missing the keys above, including `total_discounts` and any `*_set`. |
| `orders-paid-gift-card-with-discount.json` | _note_: "Shopify orders/paid with a gift card + discount. KEY FINDING (J4): discount_allocations is EMPTY on the gift-card line even though target_selection:'all'. The client's prototype test (619 pts) is wrong for real orders; real fixture asserts 559 pts. Real emails/names removed."<br>_captured_: "Phase 1 prep session"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | Hand-built. Order #1004, lines "Physical Product" (499.00) and "Gift Card" (110.00, `gift_card: true`, no `discount_allocations`). The J4 finding rests on this file, so it needs a real capture before it is relied on. Missing the keys above. |
| `refunds-create-money-only.json` | _note_: "Shopify refunds/create — money-only refund (no line items). refund_line_items:[] confirms this reverses no points. Captured from platinum-ecofynd-test-store. Real emails/names removed."<br>_captured_: "Earlier session (pre-phase1)"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `(none)` | Hand-built. Ids 1100000001 / 2001 / 1, `created_at` exactly 10:00:00+05:30, refers to the hand-built order 5678901234567. Has no `processed_at`, and is much thinner than a real `refunds/create` body (which typically also carries fields such as `note`, `user_id`, `restock`, `duties`; verify against a real capture). The "money-only refunds reverse no points" conclusion (J6) was reached from this file. |
| `orders-cancelled-rest-get.json` | _note_: "Shopify orders/cancelled payload. Source: REST GET /orders/{id}.json — NOT a live webhook delivery (live orders/cancelled webhook pending, to be triggered once the dev app subscribes — T2.2). Real emails/names removed."<br>_captured_: "Phase 1 prep session via REST GET"<br>_store_: `platinum-ecofynd-test-store.myshopify.com`; _currency_: `USD` | Hand-built, and by its own note not a webhook: a REST `GET /orders/{id}` shape, so it cannot prove the `orders/cancelled` webhook payload. Order #1005, one line "Cancelled Product". Missing the same order and line keys. T2.2 requires one live `orders/cancelled` delivery. |

## How to replace them

1. Capture real bodies from the development app (see the capture design, kept out of the repo until agreed): one `orders/paid` for each case (no discount; tax included; percentage discount; gift card with discount; a guest order), plus `refunds/create` (money-only and with line items) and a live `orders/cancelled`.
2. Redact customer data (email, phone, names, addresses, free-text notes) while keeping every key; the point of a capture is its shape.
3. Replace the files here, update or delete the `_note` fields, and re-run the adapter and earning tests. Expect some tests to need new expected values; that is the purpose of the exercise.
