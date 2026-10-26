// web/loyalty/adapters/gateway.js
//
// Shopify Gateway interface.
// Wraps calls to Shopify APIs (like creating discount codes) so they can be
// mocked or fake-implemented during testing without making real network calls.

export class ShopifyGateway {
  constructor(shop) {
    this.shop = shop;
  }

  /**
   * Helper to get an authenticated offline REST client for the shop.
   */
  async getRestClient() {
    // Imported lazily: shopify.js throws at import without SHOPIFY_API_KEY/SECRET/HOST,
    // and tests that only use the fake gateway must not need them.
    const { default: shopify } = await import('../../shopify.js');
    const sessionId = shopify.api.session.getOfflineId(this.shop);
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session) {
      throw new Error(`No offline session found for shop ${this.shop}`);
    }
    return new shopify.api.clients.Rest({ session });
  }

  /**
   * Creates a price rule for a discount code.
   */
  async createPriceRule(title, value, customerId, endsAt = null) {
    const client = await this.getRestClient();
    const data = {
      price_rule: {
        title,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: 'fixed_amount',
        value: `-${value}`,
        customer_selection: 'prerequisite',
        prerequisite_customer_ids: [parseInt(customerId, 10)],
        starts_at: new Date().toISOString(),
        ends_at: endsAt ? endsAt.toISOString() : null,
      }
    };
    const response = await client.post({ path: 'price_rules', data });
    return response.body.price_rule;
  }

  /**
   * Creates a discount code for a price rule.
   */
  async createDiscountCode(priceRuleId, code) {
    const client = await this.getRestClient();
    const data = { discount_code: { code } };
    const response = await client.post({ path: `price_rules/${priceRuleId}/discount_codes`, data });
    return response.body.discount_code;
  }

  /**
   * Helper to get an authenticated offline GraphQL client for the shop.
   */
  async getGraphqlClient() {
    const { default: shopify } = await import('../../shopify.js');
    const sessionId = shopify.api.session.getOfflineId(this.shop);
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session) {
      throw new Error(`No offline session found for shop ${this.shop}`);
    }
    return new shopify.api.clients.Graphql({ session });
  }

  /**
   * The shop's currency as an ISO code ("INR"), read with the Admin API (no access scope needed for the shop's own settings).
   * @returns {Promise<string>}
   */
  async getShopCurrency() {
    const client = await this.getGraphqlClient();
    const response = await client.request(`query shopCurrency { shop { currencyCode } }`, { retries: 2 });
    const code = response.data?.shop?.currencyCode;
    if (typeof code !== 'string' || code === '') throw new Error('Shopify did not return the shop currency');
    return code;
  }

  /**
   * Looks up an order by ID: processed_at (T2.8), plus the refunds list the
   * J3 check compares against the ledger.
   */
  async getOrder(orderId) {
    const client = await this.getRestClient();
    const response = await client.get({
      path: `orders/${orderId}`,
      query: { fields: 'id,processed_at,cancelled_at,refunds' },
    });
    return response.body.order;
  }

  /**
   * Creates a customer-bound, single-use reward discount code.
   * Throws an error with `definitive = true` when Shopify rejected it
   * (userErrors): nothing was created. Any other error is ambiguous — the
   * request may or may not have been applied.
   *
   * @param {{ code: string, title: string, amount: string, customerId: string,
   *           startsAt: Date, endsAt: Date }} input  amount is a decimal major-unit string
   * @returns {Promise<{ id: string }>} the discount node id
   */
  async createRewardDiscount({ code, title, amount, customerId, startsAt, endsAt }) {
    const client = await this.getGraphqlClient();
    const response = await client.request(
      `mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          basicCodeDiscount: {
            title,
            code,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            usageLimit: 1,
            appliesOncePerCustomer: true,
            customerSelection: { customers: { add: [`gid://shopify/Customer/${customerId}`] } },
            customerGets: {
              value: { discountAmount: { amount, appliesOnEachItem: false } },
              items: { all: true },
            },
            combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
          },
        },
        retries: 2,
      }
    );
    const result = response.data?.discountCodeBasicCreate;
    if (result?.userErrors?.length) {
      const err = new Error('Shopify rejected the discount: ' + result.userErrors.map((e) => e.message).join('; '));
      err.definitive = true;
      throw err;
    }
    const id = result?.codeDiscountNode?.id;
    if (!id) throw new Error('Shopify returned no discount id');
    return { id };
  }

  /**
   * Finds a discount by its code. Returns { id } or null if none exists.
   */
  async findDiscountByCode(code) {
    const client = await this.getGraphqlClient();
    const response = await client.request(
      `query codeDiscountNodeByCode($code: String!) {
        codeDiscountNodeByCode(code: $code) { id }
      }`,
      { variables: { code }, retries: 2 }
    );
    const node = response.data?.codeDiscountNodeByCode;
    return node ? { id: node.id } : null;
  }

  /**
   * Deletes a reward discount (used when a code is voided to cover a return). Returns true when
   * the discount is gone afterwards, including when it did not exist any more.
   * Throws on a network error or any other userError, so the caller retries.
   *
   * @param {string} discountId  the discount node id (gid://shopify/DiscountCodeNode/...)
   * @returns {Promise<boolean>}
   */
  async deleteRewardDiscount(discountId) {
    const client = await this.getGraphqlClient();
    const response = await client.request(
      `mutation discountCodeDelete($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors { field message code }
        }
      }`,
      { variables: { id: discountId }, retries: 2 }
    );
    const result = response.data?.discountCodeDelete;
    const errors = result?.userErrors || [];
    if (errors.length > 0) {
      if (errors.every((e) => /not found|does not exist|invalid/i.test(`${e.code || ''} ${e.message || ''}`))) return true;
      throw new Error('Shopify refused to delete the discount: ' + errors.map((e) => e.message).join('; '));
    }
    return Boolean(result?.deletedCodeDiscountId);
  }

  /**
   * Writes the four storefront metafields the theme blocks read, for several customers in one call
   * (metafieldsSet takes at most 25 inputs: 6 customers x 4). Throws on a network error or any
   * userError; the error carries `userErrors` (field, message, code) so the caller can tell a customer
   * that no longer exists from a transient failure.
   *
   * @param {Array<{ customerId: string, available: number, pending: number, pendingAvailableAt: Date|null, activeCode: string|null }>} items
   */
  async setCustomerMetafields(items) {
    const client = await this.getGraphqlClient();
    const metafields = items.flatMap((i) => {
      const ownerId = `gid://shopify/Customer/${i.customerId}`;
      return [
        { ownerId, namespace: 'custom', key: 'reward_points', type: 'number_integer', value: String(i.available) },
        { ownerId, namespace: 'custom', key: 'pending_points', type: 'number_integer', value: String(i.pending) },
        { ownerId, namespace: 'custom', key: 'pending_points_available_at', type: 'single_line_text_field', value: i.pendingAvailableAt ? i.pendingAvailableAt.toISOString() : 'NONE' },
        { ownerId, namespace: 'custom', key: 'earned_discount_code', type: 'single_line_text_field', value: i.activeCode || 'NONE' },
      ];
    });
    const response = await client.request(
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key }
          userErrors { field message code }
        }
      }`,
      { variables: { metafields }, retries: 2 }
    );
    const errors = response.data?.metafieldsSet?.userErrors || [];
    if (errors.length > 0) {
      const err = new Error('Shopify refused the metafields: ' + errors.map((e) => e.message).join('; '));
      err.userErrors = errors;
      throw err;
    }
  }

  /**
   * Writes the shop-level redeem rule as a JSON metafield on the app installation
   * (read in the theme blocks as app.metafields.rewards.redeem_rule).
   * @param {Object} rule
   */
  async setRuleMetafield(rule) {
    const client = await this.getGraphqlClient();
    const installation = await client.request(`query { currentAppInstallation { id } }`, { retries: 2 });
    const ownerId = installation.data?.currentAppInstallation?.id;
    if (!ownerId) throw new Error('Could not find the app installation id');
    const response = await client.request(
      `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key }
          userErrors { field message code }
        }
      }`,
      { variables: { metafields: [{ ownerId, namespace: 'rewards', key: 'redeem_rule', type: 'json', value: JSON.stringify(rule) }] }, retries: 2 }
    );
    const errors = response.data?.metafieldsSet?.userErrors || [];
    if (errors.length > 0) throw new Error('Shopify refused the rule metafield: ' + errors.map((e) => e.message).join('; '));
  }

  /**
   * Fetches collections for a list of products.
   * Placeholder for Phase 3.
   */
  async getProductCollections(productIds) {
    return {};
  }
}
