import { useState, useCallback } from 'react';
import {
  reactExtension,
  useCustomer,
  useAppMetafields,
  useApplyDiscountCodeChange,
  useDiscountCodes,
  useShop,
  Banner,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Divider,
  Icon,
  SkeletonText,
} from '@shopify/ui-extensions-react/checkout';

// ─── Extension Entry Point ────────────────────────────────────────────────────
export default reactExtension(
  'purchase.checkout.payment-method-list.render-before',
  () => <RewardsCheckoutBlock />
);

// ─── Main Component ───────────────────────────────────────────────────────────
function RewardsCheckoutBlock() {
  const customer = useCustomer();
  const shop = useShop();

  // Read points balance from customer metafield (declared in TOML — no extra API call)
  const pointsResults = useAppMetafields({ namespace: 'custom', key: 'reward_points' });
  const pointsMetafield = pointsResults?.[0]?.metafield;
  const alreadyAppliedResults = useAppMetafields({ namespace: 'custom', key: 'earned_discount_code' });
  const alreadyAppliedMetafield = alreadyAppliedResults?.[0]?.metafield;

  const applyDiscountCode = useApplyDiscountCodeChange();
  const discountCodes = useDiscountCodes();

  const [state, setState] = useState('idle'); // 'idle' | 'loading' | 'applied' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [appliedCode, setAppliedCode] = useState('');

  // Not logged in → show nothing
  if (!customer) return null;

  const points = parseInt(pointsMetafield?.value || '0', 10);

  // The reward code already applied (from a previous redemption)
  const existingCode = alreadyAppliedMetafield?.value;
  const existingCodeApplied =
    existingCode &&
    existingCode !== 'NONE' &&
    discountCodes.some(
      (d) => d.code.toUpperCase() === existingCode.toUpperCase()
    );

  // No points and no pre-existing code → show nothing
  if (points === 0 && !existingCodeApplied && state !== 'applied') return null;

  // Already applied this session or the code is already in the cart
  const isApplied = state === 'applied' || existingCodeApplied;

  // ──────────────────────────────────────────────────────────────────────────
  // handleApply — calls the App Proxy to create a one-time discount code,
  // then applies it automatically to the checkout
  // ──────────────────────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    setState('loading');
    setErrorMessage('');

    try {
      // Extract numeric customer ID from the Shopify GID
      const numericId = customer.id.replace('gid://shopify/Customer/', '');

      // Call our App Proxy endpoint — Shopify routes
      // https://{shop}.myshopify.com/apps/rewards/redeem → our backend
      const response = await fetch(
        `https://${shop.myshopifyDomain}/apps/rewards/redeem`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: numericId }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        setErrorMessage(data.error || 'Unable to apply reward points. Please try again.');
        setState('error');
        return;
      }

      // Auto-apply the discount code — customer never has to type it
      const result = await applyDiscountCode({
        type: 'addDiscountCode',
        code: data.discountCode,
      });

      if (result.type === 'error') {
        setErrorMessage(result.message || 'Could not apply the discount. Please try again.');
        setState('error');
        return;
      }

      setAppliedCode(data.discountCode);
      setState('applied');
    } catch (err) {
      setErrorMessage('Network error. Please try again.');
      setState('error');
    }
  }, [customer, shop, applyDiscountCode]);

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────
  if (isApplied) {
    return (
      <BlockStack spacing="tight">
        <Divider />
        <Banner status="success">
          <BlockStack spacing="extraTight">
            <Text size="medium" emphasis="bold">
              🎁 Reward points applied!
            </Text>
            <Text size="small" appearance="subdued">
              Your {existingCodeApplied ? existingCode : appliedCode} discount has been applied to this order.
            </Text>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }

  return (
    <BlockStack spacing="tight">
      <Divider />
      <Banner>
        <BlockStack spacing="base">
          <InlineStack blockAlignment="center" spacing="base">
            <Text size="medium" emphasis="bold">
              🎁 You have {points} reward points
            </Text>
          </InlineStack>

          <Text size="small" appearance="subdued">
            Apply your points to get ₹{points} off this order automatically.
            Any ongoing sale discounts will still apply.
          </Text>

          {state === 'error' && (
            <Text size="small" appearance="critical">
              {errorMessage}
            </Text>
          )}

          <Button
            kind="primary"
            onPress={handleApply}
            loading={state === 'loading'}
            disabled={state === 'loading'}
          >
            {state === 'loading' ? 'Applying…' : `Apply ₹${points} Reward Discount`}
          </Button>
        </BlockStack>
      </Banner>
    </BlockStack>
  );
}
