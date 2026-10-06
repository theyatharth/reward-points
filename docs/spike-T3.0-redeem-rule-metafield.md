# T3.0 spike: can a Liquid block read the redeem rule from a shop-level metafield?

**Status: NOT YET RUN.** Needs the development app installed on platinum-ecofynd-test-store
(`shopify.app.toml` still has `client_id = "REPLACE_WITH_DEV_APP_CLIENT_ID"`, so T0.8 is not
finished). Everything below is ready to paste. Fill in the result block at the end.

## What is being tested

The widget hardcodes `redeem_threshold = 100` and "30 days". Both must come from config. The
config is per shop, so the natural home is a shop-level value that the theme blocks can read
with no per-customer write.

Candidate (try this first): a **JSON metafield owned by the app installation**, read in the
app block as `app.metafields.<namespace>.<key>`. The AppInstallation is one-per-shop, so it is
a shop-level value; it needs no new scope and is readable from Liquid without a metafield
definition or storefront-access setting.

Fallback candidate (only if the first fails): owner `SHOP`, a custom namespace, read as
`shop.metafields.<namespace>.<key>`. If that also fails, fall back to the four per-customer
`custom` metafields (already works), per the plan.

## Steps

1. Get the installation id (Admin GraphQL, via `shopify app dev` GraphiQL or any Admin API client):

```graphql
query { currentAppInstallation { id } }
```

2. Write the rule (replace the owner id; values match the live settings: 100 points = ₹10, 30-day hold):

```graphql
mutation {
  metafieldsSet(metafields: [{
    ownerId: "gid://shopify/AppInstallation/REPLACE",
    namespace: "rewards",
    key: "redeem_rule",
    type: "json",
    value: "{\"pointsPerReward\":100,\"rewardValuePaise\":1000,\"holdPeriodDays\":30,\"currency\":\"INR\"}"
  }]) {
    metafields { id namespace key }
    userErrors { field message }
  }
}
```

3. Read it back from Admin API (proves the write; does not prove Liquid):

```graphql
query { currentAppInstallation { rule: metafield(namespace: "rewards", key: "redeem_rule") { jsonValue } } }
```

4. Add this at the top of `extensions/rewards-widget/blocks/rewards-widget.liquid`, replacing
   `{% assign redeem_threshold = 100 %}` and the literal "30 days" text, then `shopify app dev`
   and open the store with the app embed enabled:

```liquid
{% assign rule = app.metafields.rewards.redeem_rule.value %}
{% assign redeem_threshold = rule.pointsPerReward | default: 100 %}
{% assign hold_days = rule.holdPeriodDays | default: 30 %}
<!-- rule: {{ rule | json }} threshold: {{ redeem_threshold }} hold: {{ hold_days }} -->
```

## Pass criteria

- The HTML comment shows the real values (not `null`, not the defaults), **and**
- Changing `pointsPerReward` to 500 via step 2 and reloading shows 500 with no theme or
  extension redeploy.

If `rule` prints `null`, check in this order: the embed is enabled in the theme editor; the
namespace/key match exactly (no `$app:` prefix on the Liquid side); the metafield was written
with the owner id of *this* store's installation.

## Result (fill in)

| Item | Result |
|---|---|
| Owner | |
| Namespace / key | |
| Liquid expression that worked | |
| Update visible without redeploy? | yes / no |
| Decision | use shop-level rule metafield (T3.4/T4.5) / fall back to per-customer metafields |
