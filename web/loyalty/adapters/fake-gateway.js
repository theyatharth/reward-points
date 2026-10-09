// web/loyalty/adapters/fake-gateway.js
//
// Fake gateway for isolated testing. Avoids real network calls and allows
// injecting deliberate failures (e.g. rate limit, 500 errors).

export class FakeShopifyGateway {
  constructor(shop) {
    this.shop = shop;
    this.priceRules = new Map();
    this.discountCodes = new Map();
    this.failures = [];
    this.discounts = new Map(); // code -> { id, ...input }
    this.loseNextCreateResponse = false;
    this.collectionLookupCount = 0;
  }

  /**
   * Inject a deliberate failure for the next network call. Calling it twice
   * fails the next two calls, in order.
   */
  injectFailure(error) {
    this.failures.push(error);
  }

  _checkFailure() {
    if (this.failures.length > 0) {
      throw this.failures.shift();
    }
  }

  /**
   * Makes the next createRewardDiscount succeed on the "Shopify side" but
   * throw to the caller, as when a response is lost to a timeout.
   */
  loseNextCreateResponseOnce() {
    this.loseNextCreateResponse = true;
  }

  async createRewardDiscount(input) {
    this._checkFailure();
    if (this.discounts.has(input.code)) {
      const err = new Error('Shopify rejected the discount: code must be unique');
      err.definitive = true;
      throw err;
    }
    const discount = { id: `gid://shopify/DiscountCodeNode/${this.discounts.size + 1}`, ...input };
    this.discounts.set(input.code, discount);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new Error('Simulated timeout after Shopify accepted the discount');
    }
    return { id: discount.id };
  }

  /** Deletes a discount by its node id. Returns true even if it was already gone. */
  async deleteRewardDiscount(discountId) {
    this._checkFailure();
    for (const [code, d] of this.discounts) {
      if (d.id === discountId) this.discounts.delete(code);
    }
    this.deletedDiscountIds = [...(this.deletedDiscountIds || []), discountId];
    return true;
  }

  async findDiscountByCode(code) {
    this._checkFailure();
    const d = this.discounts.get(code);
    return d ? { id: d.id } : null;
  }

  async createPriceRule(title, value, customerId, endsAt = null) {
    this._checkFailure();
    const id = Math.floor(Math.random() * 1000000000).toString();
    const rule = {
      id,
      title,
      value: `-${value}`,
      prerequisite_customer_ids: [parseInt(customerId, 10)],
      ends_at: endsAt ? endsAt.toISOString() : null,
    };
    this.priceRules.set(id, rule);
    return rule;
  }

  async createDiscountCode(priceRuleId, code) {
    this._checkFailure();
    if (!this.priceRules.has(priceRuleId)) {
      throw new Error(`Price rule ${priceRuleId} not found`);
    }
    const id = Math.floor(Math.random() * 1000000000).toString();
    const dc = {
      id,
      price_rule_id: priceRuleId,
      code,
    };
    this.discountCodes.set(id, dc);
    return dc;
  }

  // --- Methods for test mocking ---

  addOrder(order) {
    if (!this.orders) this.orders = new Map();
    this.orders.set(String(order.id), order);
  }

  async getOrder(orderId) {
    this._checkFailure();
    if (this.orders && this.orders.has(String(orderId))) {
      return this.orders.get(String(orderId));
    }
    const err = new Error('Not Found');
    err.response = { code: 404 };
    throw err;
  }

  async getProductCollections(productIds) {
    this.collectionLookupCount++;
    this._checkFailure();
    return {};
  }
}
