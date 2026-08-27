import { useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  TextField,
  FormLayout,
  Banner,
  Toast,
  Frame,
  Button,
  Stack,
  TextContainer,
  Heading,
  TextStyle,
  Badge,
} from "@shopify/polaris";

export default function HomePage() {
  const [spendAmount, setSpendAmount] = useState("100");
  const [earnPoints, setEarnPoints] = useState("1");
  const [redeemPoints, setRedeemPoints] = useState("100");
  const [discountValue, setDiscountValue] = useState("10");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [toastActive, setToastActive] = useState(false);
  const [toastError, setToastError] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [validationErrors, setValidationErrors] = useState({});

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await fetch("/api/settings");
        if (response.ok) {
          const data = await response.json();
          setSpendAmount(String(data.spendAmount));
          setEarnPoints(String(data.earnPoints));
          setRedeemPoints(String(data.redeemPoints));
          setDiscountValue(String(data.discountValue));
        }
      } catch (error) {
        console.error("Error loading settings:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  }, []);

  function validate() {
    const errors = {};
    const fields = { spendAmount, earnPoints, redeemPoints, discountValue };
    const labels = {
      spendAmount: "Spend amount",
      earnPoints: "Earn points",
      redeemPoints: "Redeem points",
      discountValue: "Discount value",
    };
    for (const [key, val] of Object.entries(fields)) {
      const n = parseInt(val, 10);
      if (isNaN(n) || n <= 0) {
        errors[key] = `${labels[key]} must be a positive number.`;
      } else if (n > 100000) {
        errors[key] = `${labels[key]} cannot exceed 100,000.`;
      }
    }
    return errors;
  }

  const handleSave = async () => {
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }
    setValidationErrors({});
    setIsSaving(true);

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spendAmount, earnPoints, redeemPoints, discountValue }),
      });

      if (response.ok) {
        setToastMessage("Settings saved successfully!");
        setToastError(false);
      } else {
        const data = await response.json();
        setToastMessage(data.error || "Failed to save settings.");
        setToastError(true);
      }
      setToastActive(true);
    } catch {
      setToastMessage("Network error. Please try again.");
      setToastError(true);
      setToastActive(true);
    } finally {
      setIsSaving(false);
    }
  };

  const dismissToast = useCallback(() => setToastActive(false), []);

  const toastMarkup = toastActive ? (
    <Toast
      content={toastMessage}
      error={toastError}
      onDismiss={dismissToast}
      duration={3000}
    />
  ) : null;

  // Live preview
  const spendNum = parseInt(spendAmount, 10) || 0;
  const earnNum = parseInt(earnPoints, 10) || 0;
  const redeemNum = parseInt(redeemPoints, 10) || 0;
  const discountNum = parseInt(discountValue, 10) || 0;

  if (isLoading) {
    return (
      <Frame>
        <Page>
          <TextContainer>
            <p style={{ textAlign: "center", color: "#6d7175", padding: "40px" }}>
              Loading settings…
            </p>
          </TextContainer>
        </Page>
      </Frame>
    );
  }

  return (
    <Frame>
      {toastMarkup}
      <Page
        title="Reward Points Settings"
        subtitle="Configure how customers earn and redeem reward points"
        primaryAction={{
          content: "Save Settings",
          onAction: handleSave,
          loading: isSaving,
        }}
      >
        <Layout>
          <Layout.Section>
            <Stack vertical spacing="loose">

              {/* Earning Rules */}
              <Card sectioned>
                <Stack vertical spacing="loose">
                  <Stack alignment="center" distribution="equalSpacing">
                    <Stack vertical spacing="extraTight">
                      <Heading>Earning Rules</Heading>
                      <TextStyle variation="subdued">
                        How many points customers earn per purchase.
                      </TextStyle>
                    </Stack>
                    <Badge status="info">Active</Badge>
                  </Stack>

                  <hr style={{ border: "none", borderTop: "1px solid #e4e5e7", margin: "4px 0" }} />

                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="When a customer spends (₹)"
                        type="number"
                        value={spendAmount}
                        onChange={(v) => {
                          setSpendAmount(v);
                          setValidationErrors((e) => ({ ...e, spendAmount: undefined }));
                        }}
                        error={validationErrors.spendAmount}
                        autoComplete="off"
                        min="1"
                        helpText="Spend amount threshold in your store currency."
                      />
                      <TextField
                        label="They earn (Points)"
                        type="number"
                        value={earnPoints}
                        onChange={(v) => {
                          setEarnPoints(v);
                          setValidationErrors((e) => ({ ...e, earnPoints: undefined }));
                        }}
                        error={validationErrors.earnPoints}
                        autoComplete="off"
                        min="1"
                        helpText="Points awarded per spend threshold reached."
                      />
                    </FormLayout.Group>
                  </FormLayout>

                  {spendNum > 0 && earnNum > 0 && (
                    <div
                      style={{
                        background: "#f6f6f7",
                        padding: "12px 16px",
                        borderRadius: "8px",
                        fontSize: "13px",
                        color: "#444",
                      }}
                    >
                      📊 <strong>Preview:</strong> A ₹{spendNum * 5} order earns{" "}
                      <strong>{earnNum * 5} points</strong>
                    </div>
                  )}
                </Stack>
              </Card>

              {/* Redemption Rules */}
              <Card sectioned>
                <Stack vertical spacing="loose">
                  <Stack alignment="center" distribution="equalSpacing">
                    <Stack vertical spacing="extraTight">
                      <Heading>Redemption Rules</Heading>
                      <TextStyle variation="subdued">
                        How customers convert their points into discount codes.
                      </TextStyle>
                    </Stack>
                    <Badge status="info">Active</Badge>
                  </Stack>

                  <hr style={{ border: "none", borderTop: "1px solid #e4e5e7", margin: "4px 0" }} />

                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="Points required to redeem"
                        type="number"
                        value={redeemPoints}
                        onChange={(v) => {
                          setRedeemPoints(v);
                          setValidationErrors((e) => ({ ...e, redeemPoints: undefined }));
                        }}
                        error={validationErrors.redeemPoints}
                        autoComplete="off"
                        min="1"
                        helpText="Minimum points a customer needs to redeem."
                      />
                      <TextField
                        label="Discount value (₹)"
                        type="number"
                        value={discountValue}
                        onChange={(v) => {
                          setDiscountValue(v);
                          setValidationErrors((e) => ({ ...e, discountValue: undefined }));
                        }}
                        error={validationErrors.discountValue}
                        autoComplete="off"
                        min="1"
                        helpText="Discount amount generated per redemption."
                      />
                    </FormLayout.Group>
                  </FormLayout>

                  {redeemNum > 0 && discountNum > 0 && (
                    <div
                      style={{
                        background: "#f6f6f7",
                        padding: "12px 16px",
                        borderRadius: "8px",
                        fontSize: "13px",
                        color: "#444",
                      }}
                    >
                      📊 <strong>Preview:</strong> {redeemNum * 2} points → ₹
                      {discountNum * 2} discount code
                    </div>
                  )}
                </Stack>
              </Card>

              {/* Info Banner */}
              <Banner title="How it works" status="info">
                <p>
                  <strong>Earning:</strong> When a customer places a paid order,
                  they automatically receive points based on your earning rules.
                </p>
                <p style={{ marginTop: "8px" }}>
                  <strong>Redeeming:</strong> Customers can redeem points for a
                  discount code from the Rewards widget on your storefront.
                </p>
                <p style={{ marginTop: "8px" }}>
                  <strong>Manual Adjustments:</strong> Go to the{" "}
                  <strong>Customers</strong> page to award or deduct points for
                  any customer — useful for birthday rewards, re-engagement
                  campaigns, and VIP bonuses.
                </p>
              </Banner>

            </Stack>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}