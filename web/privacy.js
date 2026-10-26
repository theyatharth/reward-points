import { DeliveryMethod } from "@shopify/shopify-api";
import { recordDataRequest, redactCustomer, eraseShop } from "./loyalty/service/privacy.js";

// Never log the payload: it holds the customer's e-mail and phone.
const parse = (body) => JSON.parse(typeof body === "string" ? body : Buffer.from(body).toString("utf8"));

// The shop in the request header is not covered by the signature; shop_domain inside the signed body is. When the body names a real
// shop domain it must be the shop of the header, or nothing is redacted (a destructive request must not be redirected to another shop).
const REAL_SHOP = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
function assertSameShop(shop, payload) {
  const named = payload && typeof payload.shop_domain === "string" ? payload.shop_domain.toLowerCase() : null;
  if (named && REAL_SHOP.test(named) && named !== String(shop).toLowerCase()) {
    throw new Error("privacy webhook refused: the shop in the payload is not the shop of the request");
  }
}

/**
 * @type {{[key: string]: import("@shopify/shopify-api").WebhookHandler}}
 */
export default {
  /**
   * Customers can request their data from a store owner. When this happens,
   * Shopify invokes this privacy webhook.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-data_request
   */
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      const payload = parse(body);
      assertSameShop(shop, payload);
      const r = await recordDataRequest({ shop, payload });
      console.log(`[privacy] customers/data_request for ${shop}: ${r.stored ? (r.duplicate ? "already stored" : "stored") : "no customer in the request"} (webhook ${webhookId})`);
      // Payload has the following shape:
      // {
      //   "shop_id": 954889,
      //   "shop_domain": "{shop}.myshopify.com",
      //   "orders_requested": [
      //     299938,
      //     280263,
      //     220458
      //   ],
      //   "customer": {
      //     "id": 191167,
      //     "email": "john@example.com",
      //     "phone": "555-625-1199"
      //   },
      //   "data_request": {
      //     "id": 9999
      //   }
      // }
    },
  },

  /**
   * Store owners can request that data is deleted on behalf of a customer. When
   * this happens, Shopify invokes this privacy webhook.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-redact
   */
  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      const payload = parse(body);
      assertSameShop(shop, payload);
      const r = await redactCustomer({ shop, payload });
      console.log(`[privacy] customers/redact for ${shop}: ${r.matched ? "account redacted" : "no account for this customer"} (webhook ${webhookId})`);
      // Payload has the following shape:
      // {
      //   "shop_id": 954889,
      //   "shop_domain": "{shop}.myshopify.com",
      //   "customer": {
      //     "id": 191167,
      //     "email": "john@example.com",
      //     "phone": "555-625-1199"
      //   },
      //   "orders_to_redact": [
      //     299938,
      //     280263,
      //     220458
      //   ]
      // }
    },
  },

  /**
   * 48 hours after a store owner uninstalls your app, Shopify invokes this
   * privacy webhook.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#shop-redact
   */
  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      assertSameShop(shop, parse(body));
      await eraseShop({ shop });
      console.log(`[privacy] shop/redact for ${shop}: shop data erased (webhook ${webhookId})`);
      // Payload has the following shape:
      // {
      //   "shop_id": 954889,
      //   "shop_domain": "{shop}.myshopify.com"
      // }
    },
  },
};
