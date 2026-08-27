import {
  reactExtension,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Divider,
  useMetafield,
} from '@shopify/ui-extensions-react/customer-account';

export default reactExtension(
  'customer-account.profile.block.render',
  () => <RewardsProfileBlock />
);

function RewardsProfileBlock() {
  const pointsMetafield = useMetafield({ namespace: 'custom', key: 'reward_points' });
  const codeMetafield = useMetafield({ namespace: 'custom', key: 'earned_discount_code' });

  const points = parseInt(pointsMetafield?.value || '0', 10);
  const code = codeMetafield?.value;
  const hasActiveCode = code && code !== 'NONE';

  return (
    <Card padding>
      <BlockStack spacing="loose">

        <InlineStack blockAlignment="center" spacing="base">
          <Text size="large" emphasis="bold">🎁 My Rewards</Text>
        </InlineStack>

        <Divider />

        <BlockStack spacing="tight">
          <Text appearance="subdued" size="small">Available Points</Text>
          <Text size="extraLarge" emphasis="bold">{points}</Text>
        </BlockStack>

        {hasActiveCode ? (
          <Banner status="success" title="🎉 You have an active reward!">
            <Text>
              Your discount code: <Text emphasis="bold">{code}</Text>
            </Text>
            <Text appearance="subdued" size="small">
              Use this code at checkout to claim your discount.
            </Text>
          </Banner>
        ) : (
          <Text appearance="subdued">
            Keep shopping to earn more points! Redeem your points for discount
            codes using the Rewards widget on the store.
          </Text>
        )}

        <Divider />

        <Button to="/">
          Continue Shopping
        </Button>

      </BlockStack>
    </Card>
  );
}