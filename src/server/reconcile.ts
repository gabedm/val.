import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PaymentEvidence, PaymentPeriod } from "../shared/contracts";
import type { AppContext } from "./context";
import { artifacts, evidence, operations, providerAccounts, transitions } from "./db/schema";
import type { Commit } from "./jobs";
import type { OperationRow } from "./operations";
import {
  associationProblem,
  billingStatusOf,
  checkInitialPayment,
  observeTransaction,
  type ExpectedInitialPayment,
  type PaymentVerdict,
} from "./payment-evidence";
import {
  PaypalApiError,
  paypalFor,
  type PaypalMoney,
  type PaypalPlan,
  type PaypalSubscription,
  type PaypalTransaction,
} from "./paypal";
import { resolveSubscriptionPlan } from "./plans";

type BillingStatus = NonNullable<OperationRow["billingStatus"]>;

const queryLookbackMs = 5 * 60 * 1000;

const pounds = (minorUnits: number) => (minorUnits / 100).toFixed(2);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A 404 means the resource or list is not visible in this merchant context; it is not an error to retry. */
export async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PaypalApiError && error.httpStatus === 404) return null;
    throw error;
  }
}

/**
 * Reads the operation's subscription in its own merchant context and records what was observed:
 * the sanitized source artifact, subscription status and independent initial-payment verdict.
 * Returns the observed billing status. Nothing is written when nothing changed since the last pass.
 */
export async function reconcileSubscription(
  ctx: AppContext,
  operation: OperationRow,
  commit: Commit,
): Promise<BillingStatus> {
  const client = paypalFor(ctx.paypal, operation.merchant);
  const plan = resolveSubscriptionPlan(ctx.planMapping, operation.planId);
  // A purchase made from consent is verified against the terms the user accepted, not whatever the plan costs now.
  const [transition] = operation.transitionId
    ? await ctx.db
        .select({ terms: transitions.acceptedPurchaseTerms })
        .from(transitions)
        .where(eq(transitions.id, operation.transitionId))
    : [];
  const expected: ExpectedInitialPayment = {
    subscriptionId: operation.remoteId!,
    paypalPlanId: plan.paypalPlanId,
    customId: operation.customId!,
    recurringMinor: transition?.terms.dueNow.amountMinor ?? plan.recurringMinor,
    ...(transition?.terms.offer ? { offer: transition.terms.offer } : {}),
  };
  const observedAt = new Date();
  const queryStart = new Date(operation.dispatchedAt!.getTime() - queryLookbackMs);

  const subscription = await readOrNull(() => client.getSubscription(expected.subscriptionId));
  const problem = subscription
    ? associationProblem(subscription, expected)
    : "The subscription was not found in this merchant's context.";

  let paypalPlan: PaypalPlan | null = null;
  let rawTransactions: PaypalTransaction[] | null = null;
  if (subscription && !problem) {
    paypalPlan = await client.getPlan(expected.paypalPlanId);
    rawTransactions = await readOrNull(() =>
      client.listTransactions(expected.subscriptionId, queryStart, observedAt),
    );
  }
  const observedTransactions = rawTransactions?.map(observeTransaction) ?? null;

  // Initial payment is a historical fact: cancelling billing later must not undo it.
  const paymentAlreadyVerified = operation.paymentStatus === "VERIFIED";
  let verdict: PaymentVerdict | null = null;
  if (!paymentAlreadyVerified) {
    verdict =
      subscription && paypalPlan && !problem
        ? checkInitialPayment({
            expected,
            subscription,
            plan: paypalPlan,
            transactions: observedTransactions,
          })
        : { verdict: "FAILED", reason: problem! };
  }

  const billingStatus = subscription ? billingStatusOf(subscription.status) : "UNKNOWN";

  await commit(async (tx) => {
    // Serialize observations of this operation; a slower old read must not replace newer evidence.
    const [current] = await tx.select().from(operations).where(eq(operations.id, operation.id)).for("update");
    const [latest] = await tx
      .select({ detail: evidence.detail, observedAt: evidence.observedAt })
      .from(evidence)
      .where(
        and(
          eq(evidence.operationId, operation.id),
          eq(evidence.kind, "subscription"),
          eq(evidence.advisory, false),
        ),
      )
      .orderBy(desc(evidence.observedAt))
      .limit(1);
    if (latest && latest.observedAt.getTime() >= observedAt.getTime()) return;
    if (current!.paymentStatus === "VERIFIED") verdict = null;
    const fingerprint = sha256(JSON.stringify([billingStatus, verdict, observedTransactions]));
    if ((latest?.detail as { fingerprint?: string } | null)?.fingerprint === fingerprint) return;

    const sourceTransactions =
      rawTransactions?.map((transaction) => ({
        id: transaction.id,
        status: transaction.status,
        time: transaction.time,
        amount_with_breakdown: { gross_amount: sourceMoney(transaction.amount_with_breakdown?.gross_amount) },
      })) ?? null;
    const artifactContent = JSON.stringify(
      {
        observedAt,
        subscription: withoutBuyerDetails(subscription),
        plan: paypalPlan,
        transactionQuery: { start: queryStart, end: observedAt },
        transactions: sourceTransactions,
      },
      null,
      2,
    );
    const artifactId = randomUUID();
    await tx.insert(artifacts).values({
      id: artifactId,
      caseId: operation.caseId,
      mimeType: "application/json",
      content: artifactContent,
      sha256: sha256(artifactContent),
    });

    const providerId = plan.providerId;
    const subscriptionEvidenceId = randomUUID();
    await tx.insert(evidence).values({
      id: subscriptionEvidenceId,
      caseId: operation.caseId,
      operationId: operation.id,
      providerId,
      planId: operation.planId,
      kind: "subscription",
      observedAt,
      artifactId,
      summary: `PayPal subscription ${expected.subscriptionId} (merchant ${operation.merchant}, plan ${operation.planId}) is ${subscription?.status ?? "not visible"}.`,
      detail: { fingerprint, status: subscription?.status ?? null },
    });

    let paymentEvidenceId: string | null = null;
    if (verdict) {
      paymentEvidenceId = randomUUID();
      const payments: PaymentEvidence[] = (observedTransactions ?? []).map((transaction) => ({
        id: randomUUID(),
        caseId: operation.caseId,
        providerId,
        merchantContext: operation.merchant,
        subscriptionId: expected.subscriptionId,
        transactionId: transaction.id,
        status: transaction.status,
        grossAmount: transaction.gross,
        transactionTime: transaction.time ? new Date(transaction.time).toISOString() : null,
        queryStart: queryStart.toISOString(),
        queryEnd: observedAt.toISOString(),
        observedAt: observedAt.toISOString(),
        sourceArtifactId: artifactId,
      }));
      let period: PaymentPeriod | null = null;
      if (verdict.verdict === "VERIFIED") {
        const transactionId = verdict.transaction.id;
        period = {
          subscriptionId: expected.subscriptionId,
          paymentEvidenceId: payments.find((payment) => payment.transactionId === transactionId)!.id,
          ...verdict.period,
          boundaryEvidenceId: subscriptionEvidenceId,
        };
      }
      await tx.insert(evidence).values({
        id: paymentEvidenceId,
        caseId: operation.caseId,
        operationId: operation.id,
        providerId,
        planId: operation.planId,
        kind: "payment",
        observedAt,
        artifactId,
        summary: describeVerdict(verdict),
        detail: { verdict: verdict.verdict, payments, period },
      });
    }

    await tx
      .update(operations)
      .set({
        billingStatus,
        ...(verdict && {
          paymentStatus: verdict.verdict,
          note: describeVerdict(verdict),
          ...(verdict.verdict === "VERIFIED" && { resultEvidenceId: paymentEvidenceId }),
        }),
        updatedAt: new Date(),
      })
      .where(eq(operations.id, operation.id));

    // The verified initial payment is what gives Provider A's workspace its subscription and paid-through boundary.
    if (verdict?.verdict === "VERIFIED" && operation.kind === "setup_create" && !operation.probe) {
      await tx
        .update(providerAccounts)
        .set({ subscriptionId: expected.subscriptionId, paidThrough: new Date(verdict.period.paidThrough) })
        .where(
          and(eq(providerAccounts.caseId, operation.caseId), eq(providerAccounts.providerId, "provider_a")),
        );
    }
  });
  return billingStatus;
}

function describeVerdict(verdict: PaymentVerdict): string {
  if (verdict.verdict !== "VERIFIED")
    return `Initial payment ${verdict.verdict.toLowerCase()}: ${verdict.reason}`;
  const { transaction, period } = verdict;
  return `Initial payment verified: transaction ${transaction.id} COMPLETED GBP ${pounds(transaction.gross!.amountMinor)}; paid period ${period.periodStart} to ${period.paidThrough}.`;
}

const sourceMoney = (money: PaypalMoney | undefined) =>
  money && { currency_code: money.currency_code, value: money.value };

/** Retain the subscription facts used by the payment check, excluding buyer data and approval tokens. */
function withoutBuyerDetails(subscription: PaypalSubscription | null) {
  if (!subscription) return null;
  const billing = subscription.billing_info;
  return {
    id: subscription.id,
    plan_id: subscription.plan_id,
    custom_id: subscription.custom_id,
    plan_overridden: subscription.plan_overridden,
    status: subscription.status,
    start_time: subscription.start_time,
    shipping_amount: sourceMoney(subscription.shipping_amount),
    billing_info: billing && {
      outstanding_balance: sourceMoney(billing.outstanding_balance),
      cycle_executions: billing.cycle_executions?.map(
        ({ tenure_type, sequence, cycles_completed, cycles_remaining, total_cycles }) => ({
          tenure_type,
          sequence,
          cycles_completed,
          cycles_remaining,
          total_cycles,
        }),
      ),
      next_billing_time: billing.next_billing_time,
      last_payment: billing.last_payment && {
        amount: sourceMoney(billing.last_payment.amount),
        time: billing.last_payment.time,
      },
    },
  };
}
