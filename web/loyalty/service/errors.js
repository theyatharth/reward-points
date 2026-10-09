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
