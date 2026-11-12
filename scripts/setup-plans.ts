import { existsSync, writeFileSync } from "node:fs";
import { readMerchants, type Merchant } from "../src/server/config";
import { describePlanMismatch } from "../src/server/payment-evidence";
import { createPaypalClients } from "../src/server/paypal";
import { fixturePlans, planMappingPath, readPlanMapping } from "../src/server/plans";

// Reuses the four original monthly GBP plans and configures one paid-intro plan under merchant B.
// Records PayPal IDs only. Safe to re-run: existing schedules are verified, never recreated. Fixed
// PayPal-Request-Ids also stop an interrupted run from creating duplicates.
if (existsSync(".env")) process.loadEnvFile(".env");
const clients = createPaypalClients(readMerchants());
const mapping = readPlanMapping();

// Each merchant has one product shared by its plans.
const productByMerchant: Partial<Record<Merchant, string>> = {};
for (const plan of fixturePlans) {
  if (mapping[plan.planId]) productByMerchant[plan.merchant] = mapping[plan.planId]!.productId;
}

for (const plan of fixturePlans) {
  const client = clients[plan.merchant];
  if (!client)
    throw new Error(`Sandbox merchant ${plan.merchant} is not configured; cannot set up ${plan.planId}.`);
  const price = (plan.recurringMinor / 100).toFixed(2);
  const introductory =
    plan.introductoryMinor !== undefined && plan.introductoryCycles !== undefined
      ? {
          introductoryAmount: { currency: "GBP" as const, amountMinor: plan.introductoryMinor },
          introductoryCycles: plan.introductoryCycles,
          regularAmount: { currency: "GBP" as const, amountMinor: plan.recurringMinor },
          setupFee: { currency: "GBP" as const, amountMinor: 0 },
        }
      : undefined;

  const existing = mapping[plan.planId];
  if (existing) {
    const remote = await client.getPlan(existing.paypalPlanId);
    const mismatch = describePlanMismatch(remote, plan.recurringMinor, introductory);
    if (mismatch)
      throw new Error(
        `Recorded plan ${plan.planId} no longer matches its authored billing schedule: ${mismatch}`,
      );
    console.log(`${plan.planId}: verified ${existing.paypalPlanId}`);
    continue;
  }

  productByMerchant[plan.merchant] ??= (
    await client.createProduct(
      {
        name: `Val demo merchant ${plan.merchant}`,
        type: "SERVICE",
        description: "Authored demo merchant for Val sandbox subscriptions; no live funds.",
      },
      `val-product-${plan.merchant}`,
    )
  ).id;
  const productId = productByMerchant[plan.merchant]!;

  const created = await client.createPlan(
    {
      product_id: productId,
      name: introductory
        ? `Val ${plan.planId}: £${(introductory.introductoryAmount.amountMinor / 100).toFixed(2)} for ${introductory.introductoryCycles} months, then £${price}`
        : `Val ${plan.planId} monthly £${price}`,
      status: "ACTIVE",
      billing_cycles: [
        ...(introductory
          ? [
              {
                frequency: { interval_unit: "MONTH", interval_count: 1 },
                tenure_type: "TRIAL",
                sequence: 1,
                total_cycles: introductory.introductoryCycles,
                pricing_scheme: {
                  fixed_price: {
                    value: (introductory.introductoryAmount.amountMinor / 100).toFixed(2),
                    currency_code: "GBP",
                  },
                },
              },
            ]
          : []),
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: introductory ? 2 : 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: price, currency_code: "GBP" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
    },
    `val-plan-${plan.planId}`,
  );
  mapping[plan.planId] = { productId, paypalPlanId: created.id };
  writeFileSync(planMappingPath, JSON.stringify(mapping, null, 2));
  console.log(`${plan.planId}: created ${created.id}`);
}
