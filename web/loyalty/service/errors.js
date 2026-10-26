// web/loyalty/service/errors.js
//
// An error carrying `permanent = true` cannot be cured by retrying the same event
// (a payload that is not a JSON object, a refund that names an impossible quantity):
// markWebhookFailed sends such an event straight to 'dead' with the reason in lastError.
// (RefundDataError in rules/refund-lines.js sets the same flag.)

export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.permanent = true;
  }
}

// The shop has no LoyaltyConfig yet (its install setup has not run or its currency could not be read). Not permanent: the
// event waits and is retried until the shop is set up (see waitingPlan in webhook.js), because earning with made-up default
// rules in the wrong currency would be worse than waiting.
export class ShopNotSetUpError extends Error {
  constructor(shop) {
    super(`The shop ${shop} is not set up yet (no rewards configuration); waiting for it`);
    this.name = 'ShopNotSetUpError';
    this.waitingForShop = true;
  }
}
