// web/loyalty/adapters/gateway.js
//
// Shopify Gateway interface.
// Wraps calls to Shopify APIs (like creating discount codes) so they can be
// mocked or fake-implemented during testing without making real network calls.

import shopify from '../../shopify.js';

export class ShopifyGateway {
  constructor(shop) {
    this.shop = shop;
  }

  /**
   * Helper to get an authenticated offline REST client for the shop.
   */
  async getRestClient() {
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
    const sessionId = shopify.api.session.getOfflineId(this.shop);
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (!session) {
      throw new Error(`No offline session found for shop ${this.shop}`);
    }
    return new shopify.api.clients.Graphql({ session });
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
   * Fetches collections for a list of products.
   * Placeholder for Phase 3.
   */
  async getProductCollections(productIds) {
    return {};
  }
}
