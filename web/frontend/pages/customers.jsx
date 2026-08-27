import { useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  TextField,
  Select,
  Button,
  Modal,
  TextContainer,
  Toast,
  Frame,
  Stack,
  Heading,
  TextStyle,
  Badge,
  Banner,
  Spinner,
  EmptyState,
} from "@shopify/polaris";

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  // Modal state
  const [modalActive, setModalActive] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [adjustPoints, setAdjustPoints] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustType, setAdjustType] = useState("award");
  const [isSaving, setIsSaving] = useState(false);
  const [pointsError, setPointsError] = useState("");
  const [reasonError, setReasonError] = useState("");

  // Toast state
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);

  const dismissToast = useCallback(() => setToastActive(false), []);

  const loadCustomers = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/customers/points");
      if (response.ok) {
        const data = await response.json();
        setCustomers(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.error("Error loading customers:", err);
      setCustomers([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  const openModal = (customer) => {
    setSelectedCustomer(customer);
    setAdjustPoints("");
    setAdjustReason("");
    setAdjustType("award");
    setPointsError("");
    setReasonError("");
    setModalActive(true);
  };

  const closeModal = () => {
    setModalActive(false);
    setSelectedCustomer(null);
  };

  const handleAdjust = async () => {
    let hasError = false;
    const pts = parseInt(adjustPoints, 10);
    if (isNaN(pts) || pts <= 0) {
      setPointsError("Please enter a positive number of points.");
      hasError = true;
    } else {
      setPointsError("");
    }
    if (!adjustReason.trim()) {
      setReasonError("A reason is required for audit purposes.");
      hasError = true;
    } else {
      setReasonError("");
    }
    if (hasError) return;

    setIsSaving(true);
    const finalPoints = adjustType === "award" ? pts : -pts;

    try {
      const response = await fetch("/api/customers/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopifyCustomerId: selectedCustomer.shopifyCustomerId,
          points: finalPoints,
          reason: adjustReason.trim(),
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setToastMessage(
          `Successfully ${adjustType === "award" ? "awarded" : "deducted"} ${pts} points. New balance: ${data.newBalance}`
        );
        setToastError(false);
        setToastActive(true);
        closeModal();
        loadCustomers();
      } else {
        setToastMessage(data.error || "Failed to adjust points.");
        setToastError(true);
        setToastActive(true);
      }
    } catch {
      setToastMessage("Network error. Please try again.");
      setToastError(true);
      setToastActive(true);
    } finally {
      setIsSaving(false);
    }
  };

  const filteredCustomers = customers.filter((c) =>
    searchQuery
      ? c.shopifyCustomerId.toLowerCase().includes(searchQuery.toLowerCase())
      : true
  );

  const rows = filteredCustomers.map((c) => {
    const pts = c.points;
    const badgeStatus = pts >= 500 ? "success" : pts >= 100 ? "warning" : "info";
    const badgeLabel = pts >= 500 ? "VIP" : pts >= 100 ? "Active" : "New";
    const customerId = c.shopifyCustomerId.replace("gid://shopify/Customer/", "");
    const updatedDate = new Date(c.updatedAt).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

    return [
      <TextStyle variation="subdued">{customerId}</TextStyle>,
      <Stack alignment="center" spacing="tight">
        <strong>{pts.toLocaleString()}</strong>
        <Badge status={badgeStatus}>{badgeLabel}</Badge>
      </Stack>,
      <TextStyle variation="subdued">{updatedDate}</TextStyle>,
      <Button plain size="slim" onClick={() => openModal(c)}>
        Adjust Points
      </Button>,
    ];
  });

  const toastMarkup = toastActive ? (
    <Toast
      content={toastMessage}
      error={toastError}
      onDismiss={dismissToast}
      duration={4000}
    />
  ) : null;

  const adjustTypeOptions = [
    { label: "Award Points (+)", value: "award" },
    { label: "Deduct Points (−)", value: "deduct" },
  ];

  const reasonSuggestions =
    adjustType === "award"
      ? ["Birthday Bonus", "Re-engagement Reward", "VIP Gift", "Compensation", "Campaign Reward"]
      : ["Fraud Prevention", "Refund Adjustment", "Policy Violation"];

  return (
    <Frame>
      {toastMarkup}
      <Page
        title="Customers"
        subtitle="View and manually manage customer point balances"
        secondaryActions={[
          {
            content: "Refresh",
            onAction: loadCustomers,
            loading: isLoading,
          },
        ]}
      >
        <Layout>
          <Layout.Section>
            <Stack vertical spacing="loose">

              <Banner title="Manual Points Adjustment" status="info">
                <p>
                  Award or deduct points for any customer. Use this for
                  re-engagement campaigns, birthday rewards, VIP bonuses, or
                  any custom promotion.{" "}
                  <strong>A reason is always required</strong> for audit
                  purposes.
                </p>
              </Banner>

              <Card>
                <Card.Section>
                  <Stack alignment="center" distribution="equalSpacing">
                    <Heading>All Customers ({customers.length})</Heading>
                    <div style={{ maxWidth: "280px" }}>
                      <TextField
                        label=""
                        labelHidden
                        placeholder="Search by customer ID…"
                        value={searchQuery}
                        onChange={setSearchQuery}
                        clearButton
                        onClearButtonClick={() => setSearchQuery("")}
                        autoComplete="off"
                      />
                    </div>
                  </Stack>
                </Card.Section>

                <Card.Section flush>
                  {isLoading ? (
                    <div style={{ padding: "40px", textAlign: "center" }}>
                      <Spinner size="large" />
                    </div>
                  ) : filteredCustomers.length === 0 ? (
                    <EmptyState
                      heading={
                        searchQuery
                          ? "No customers match your search"
                          : "No customers yet"
                      }
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>
                        {searchQuery
                          ? "Try a different search term."
                          : "Customers will appear here once they make their first purchase."}
                      </p>
                    </EmptyState>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text"]}
                      headings={[
                        "Customer ID",
                        "Points Balance",
                        "Last Updated",
                        "Actions",
                      ]}
                      rows={rows}
                    />
                  )}
                </Card.Section>
              </Card>

            </Stack>
          </Layout.Section>
        </Layout>

        {/* Adjust Points Modal */}
        <Modal
          open={modalActive}
          onClose={closeModal}
          title={
            selectedCustomer
              ? `Adjust Points — Customer ${selectedCustomer.shopifyCustomerId.replace("gid://shopify/Customer/", "")}`
              : "Adjust Points"
          }
          primaryAction={{
            content: adjustType === "award" ? "Award Points" : "Deduct Points",
            onAction: handleAdjust,
            loading: isSaving,
            destructive: adjustType === "deduct",
          }}
          secondaryActions={[{ content: "Cancel", onAction: closeModal }]}
        >
          <Modal.Section>
            <Stack vertical spacing="loose">
              {selectedCustomer && (
                <div
                  style={{
                    background: "#f6f6f7",
                    padding: "14px 16px",
                    borderRadius: "8px",
                  }}
                >
                  <Stack alignment="center" spacing="tight">
                    <TextStyle variation="subdued">Current Balance:</TextStyle>
                    <strong style={{ fontSize: "20px" }}>
                      {selectedCustomer.points.toLocaleString()} pts
                    </strong>
                  </Stack>
                </div>
              )}

              <Select
                label="Action"
                options={adjustTypeOptions}
                value={adjustType}
                onChange={setAdjustType}
              />

              <TextField
                label="Number of Points"
                type="number"
                value={adjustPoints}
                onChange={(v) => {
                  setAdjustPoints(v);
                  setPointsError("");
                }}
                error={pointsError}
                min="1"
                autoComplete="off"
                helpText={`Points will be ${adjustType === "award" ? "added to" : "deducted from"} the customer's balance.`}
              />

              <Stack vertical spacing="tight">
                <TextField
                  label="Reason (required)"
                  value={adjustReason}
                  onChange={(v) => {
                    setAdjustReason(v);
                    setReasonError("");
                  }}
                  error={reasonError}
                  autoComplete="off"
                  helpText="Recorded in the audit log for accountability."
                  placeholder={
                    adjustType === "award"
                      ? "e.g. Birthday Bonus"
                      : "e.g. Fraud Prevention"
                  }
                />
                {/* Quick-fill reason suggestions */}
                <Stack spacing="tight" wrap>
                  {reasonSuggestions.map((s) => (
                    <Button
                      key={s}
                      plain
                      size="slim"
                      onClick={() => {
                        setAdjustReason(s);
                        setReasonError("");
                      }}
                    >
                      {s}
                    </Button>
                  ))}
                </Stack>
              </Stack>
            </Stack>
          </Modal.Section>
        </Modal>
      </Page>
    </Frame>
  );
}
