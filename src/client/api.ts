import type {
  ApprovalResult,
  AsyncCommandResult,
  CaseSnapshot,
  CaseSummary,
  CatalogueResponse,
  CleanupCommand,
  Consent,
  ConsentCommand,
  CreateCaseCommand,
  Evidence,
  ExitAuthorization,
  ExitReview,
  LoginCommand,
  LoginResult,
  Operation,
  Policy,
  PolicyDraft,
  PolicyFields,
  PurchasePreview,
  ReturnCommand,
  SessionView,
  WhatIfCommand,
  WhatIfResult,
} from "../shared/contracts.types";
import type {
  SubscriptionAdvice,
  SubscriptionCommand,
  SubscriptionImport,
  SubscriptionIngestionProgress,
  SubscriptionPortfolio,
  SavedSubscriptionReview,
  ValChatReply,
  ValChatCommand,
  ValChatRequest,
} from "../shared/subscriptions";
import { readIngestionStream } from "./chat-stream";
import { subscriptionAdviceFormat } from "../shared/subscriptions";
import type { PriceCheckDraft, PriceCheckSchedule } from "../shared/price-checks";
import {
  paypalWalletConsentVersion,
  paypalWalletRefreshMs,
  type PayPalWalletStatus,
  type WalletCandidateCommand,
} from "../shared/paypal-wallet";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly completedChatRequest = false,
  ) {
    super(message);
  }
}

let csrfToken = "";

async function request<T>(
  method: string,
  path: string,
  body?: object,
  signal?: AbortSignal,
  allowNull = false,
  timeoutMs?: number,
): Promise<T> {
  signal?.throwIfAborted();
  const transportSignal = timeoutMs
    ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
    : signal;
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
      "X-Val-Advice-Format": subscriptionAdviceFormat,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: transportSignal,
  });
  const payload = await response.json().catch(() => undefined);
  transportSignal?.throwIfAborted();
  signal?.throwIfAborted();
  if (!response.ok)
    throw new ApiError(
      response.status,
      payload?.error ?? "error",
      payload?.message ?? response.statusText,
      Number(response.headers.get("Retry-After")) || undefined,
    );
  if (payload === undefined || (payload === null && !allowNull))
    throw new ApiError(
      response.status,
      "invalid_response",
      "Val returned an unreadable response. Please try again.",
    );
  return payload as T;
}

const remember = (session: SessionView) => {
  csrfToken = session.csrfToken;
  return session;
};

function chatPollWait(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function awaitChatRequest(
  id: string,
  signal: AbortSignal,
  onProgress?: (event: SubscriptionIngestionProgress) => void,
  initial?: ValChatRequest,
): Promise<ValChatReply> {
  const deadline = Date.now() + 300_000;
  const delivered = new Set<string>();
  let row = initial;
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    if (!row) {
      try {
        row = await request<ValChatRequest>(
          "GET",
          `/api/subscriptions/chat/requests/${encodeURIComponent(id)}`,
          undefined,
          signal,
          false,
          15_000,
        );
        failures = 0;
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof ApiError &&
          error.code === "request_rate_limited" &&
          error.retryAfterSeconds &&
          error.retryAfterSeconds <= 60 &&
          Date.now() + error.retryAfterSeconds * 1000 < deadline
        ) {
          await chatPollWait(error.retryAfterSeconds * 1000 + 150, signal);
          continue;
        }
        if (error instanceof ApiError && ![500, 502, 503, 504].includes(error.status)) throw error;
        if (Date.now() >= deadline)
          throw new ApiError(503, "chat_reconnect", "Your reply is still saved. Reconnect to continue.");
        await chatPollWait(
          Math.min(5000, 500 * 2 ** Math.min(failures++, 3)) + Math.floor(Math.random() * 200),
          signal,
        );
        continue;
      }
    }
    for (const event of row.progress) {
      const key = JSON.stringify(event);
      if (!delivered.has(key)) {
        delivered.add(key);
        onProgress?.(event);
      }
    }
    if (row.status === "complete" && row.reply) return row.reply;
    if (row.status === "complete")
      throw new ApiError(
        503,
        "invalid_response",
        "Your reply could not be read. Please try again.",
        undefined,
        true,
      );
    if (row.status === "failed" || row.status === "superseded")
      throw new ApiError(
        row.error?.status ?? 503,
        row.error?.code ?? "chat_interrupted",
        row.error?.message ?? "Your answer is safe; please try again.",
        row.error?.retryAfterSeconds,
        true,
      );
    if (Date.now() >= deadline)
      throw new ApiError(503, "chat_reconnect", "Your reply is still saved. Reconnect to continue.");
    row = undefined;
    await chatPollWait(1000, signal);
  }
}

export const api = {
  switchExample: (signal?: AbortSignal) =>
    request<import("../shared/switch-example").SwitchExampleView>(
      "GET",
      "/api/switch-example",
      undefined,
      signal,
    ),
  setupSwitchExample: (serviceId?: string, expectedRevision?: number) =>
    request<import("../shared/switch-example").SwitchExampleView>("POST", "/api/switch-example", {
      consent: "sandbox-switch-example.1",
      ...(serviceId ? { serviceId, expectedRevision } : {}),
    }),
  startSwitchExample: () =>
    request<import("../shared/switch-example").SwitchExampleView>("POST", "/api/switch-example/start", {
      consent: "subscription-switch.1",
    }),
  exampleSubscriptionSwitch: (id: string, signal?: AbortSignal) =>
    request<import("../shared/subscription-switch").SubscriptionSwitchView>(
      "GET",
      `/api/switch-example/subscriptions/switches/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  exampleSwitchAction: (
    id: string,
    action: "approve" | "resume" | "stop",
    revision: number,
    digest?: string,
  ) =>
    request<import("../shared/subscription-switch").SubscriptionSwitchView>(
      "POST",
      `/api/switch-example/subscriptions/switches/${encodeURIComponent(id)}/${action}`,
      {
        revision,
        ...(action === "approve" ? { digest, consent: "subscription-switch.1", confirmed: true } : {}),
      },
    ),
  latestChatRequest: (signal?: AbortSignal) =>
    request<ValChatRequest | null>("GET", "/api/subscriptions/chat/latest", undefined, signal, true, 15_000),
  resumeChatRequest: (
    id: string,
    signal: AbortSignal,
    onProgress?: (event: SubscriptionIngestionProgress) => void,
  ) => awaitChatRequest(id, signal, onProgress),
  async durableValChat(
    id: string,
    command: ValChatCommand,
    signal: AbortSignal,
    onProgress?: (event: SubscriptionIngestionProgress) => void,
  ) {
    let row: ValChatRequest | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        row = await request<ValChatRequest>(
          "POST",
          "/api/subscriptions/chat/requests",
          { id, command },
          signal,
          false,
          15_000,
        );
        break;
      } catch (error) {
        signal.throwIfAborted();
        if ((error instanceof ApiError && ![500, 502, 503, 504].includes(error.status)) || attempt === 2)
          throw error;
        // Retrying creation with the same ID cannot create another funded turn.
        await chatPollWait(500 * (attempt + 1), signal);
      }
    }
    return awaitChatRequest(row!.id, signal, onProgress, row);
  },
  switches: (signal?: AbortSignal) =>
    request<import("../shared/subscription-switch").SubscriptionSwitchView[]>(
      "GET",
      "/api/subscriptions/switches",
      undefined,
      signal,
    ),
  subscriptionSwitch: (id: string, signal?: AbortSignal) =>
    request<import("../shared/subscription-switch").SubscriptionSwitchView>(
      "GET",
      `/api/subscriptions/switches/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  startSwitch: (serviceId: string, optionId: string, expectedRevision: number) =>
    request<import("../shared/subscription-switch").SubscriptionSwitchView>(
      "POST",
      "/api/subscriptions/switches",
      { serviceId, optionId, expectedRevision, consent: "subscription-switch.1" },
    ),
  switchAction: (id: string, action: "approve" | "resume" | "stop", revision: number, digest?: string) =>
    request<import("../shared/subscription-switch").SubscriptionSwitchView>(
      "POST",
      `/api/subscriptions/switches/${encodeURIComponent(id)}/${action}`,
      {
        revision,
        ...(action === "approve" ? { digest, consent: "subscription-switch.1", confirmed: true } : {}),
      },
    ),
  paypalWallet: (signal?: AbortSignal) =>
    request<PayPalWalletStatus>("GET", "/api/paypal/wallet", undefined, signal),
  connectPayPalWallet: (signal?: AbortSignal) =>
    request<PayPalWalletStatus>(
      "POST",
      "/api/paypal/wallet/connect",
      { consent: paypalWalletConsentVersion },
      signal,
    ),
  async openPayPalWallet(signal: AbortSignal): Promise<PayPalWalletStatus> {
    const status = await api.paypalWallet(signal);
    if (
      status.phase === "complete" &&
      status.checkedAt &&
      Date.now() - Date.parse(status.checkedAt) >= paypalWalletRefreshMs
    )
      return api.connectPayPalWallet(signal);
    return status;
  },
  checkPayPalWallet: (signal?: AbortSignal) =>
    request<PayPalWalletStatus>("POST", "/api/paypal/wallet/check", {}, signal),
  disconnectPayPalWallet: (signal?: AbortSignal) =>
    request<PayPalWalletStatus>("DELETE", "/api/paypal/wallet", {}, signal),
  reviewPayPalPayment: (command: WalletCandidateCommand, signal?: AbortSignal) =>
    request<PayPalWalletStatus>("POST", "/api/paypal/wallet/review", command, signal),
  deployment: () => request<import("../shared/deployment").DeploymentCapabilities>("GET", "/api/deployment"),
  judgeAccess: () =>
    request<{ required: boolean; allowed: boolean; privateLink?: boolean }>("GET", "/api/judge/access"),
  enterPrivateLink: (access: string) =>
    request<{ allowed: boolean }>("POST", "/api/judge/access-link", { access }),
  enterJudgeDemo: (username: string, password: string) =>
    request<{ allowed: boolean }>("POST", "/api/judge/access", { username, password }),
  ownerAccess: () => request<{ required: boolean; allowed: boolean }>("GET", "/api/owner/access"),
  enterOwnerAccess: (username: string, password: string) =>
    request<{ allowed: boolean }>("POST", "/api/owner/access", { username, password }),
  async ingestSubscriptions(
    expectedRevision: number,
    onProgress: (event: SubscriptionIngestionProgress) => void,
    signal: AbortSignal,
    revisitServiceIds?: string[],
  ) {
    const response = await fetch("/api/subscriptions/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        message: null,
        history: [],
        expectedRevision,
        ...(revisitServiceIds?.length ? { revisitServiceIds } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new ApiError(
        response.status,
        error?.error ?? "error",
        error?.message ?? "Val couldn’t check your subscriptions. Please try again.",
        Number(response.headers.get("Retry-After")) || undefined,
      );
    }
    if (response.headers.get("Content-Type")?.includes("application/x-ndjson"))
      return readIngestionStream(response, onProgress);
    const reply = await response.json().catch(() => null);
    if (!reply) throw new Error("Val couldn’t finish reading your subscriptions. Please try again.");
    return reply as ValChatReply;
  },
  valChat: (
    message: string | null,
    history: { from: "you" | "val"; text: string }[],
    expectedRevision: number,
    revisitServiceIds: string[] = [],
    activeServiceId?: string | null,
    signal?: AbortSignal,
  ) =>
    request<ValChatReply>(
      "POST",
      "/api/subscriptions/chat",
      {
        message,
        history,
        expectedRevision,
        ...(revisitServiceIds.length ? { revisitServiceIds } : {}),
        ...(activeServiceId ? { activeServiceId } : {}),
      },
      signal,
    ),
  subscriptions: (signal?: AbortSignal) =>
    request<SubscriptionPortfolio>("GET", "/api/subscriptions", undefined, signal),
  subscriptionInsights: (revision: number, signal?: AbortSignal) =>
    request<import("../shared/subscription-insights").SubscriptionInsights>(
      "GET",
      `/api/subscriptions/insights?revision=${revision}`,
      undefined,
      signal,
    ),
  priceChecks: (signal?: AbortSignal) =>
    request<{ schedules: PriceCheckSchedule[] }>("GET", "/api/subscriptions/price-checks", undefined, signal),
  savePriceChecks: (draft: PriceCheckDraft, expectedRevision: number) =>
    request<{ schedules: PriceCheckSchedule[] }>("PUT", "/api/subscriptions/price-checks", {
      ...draft,
      expectedRevision,
    }),
  importSubscriptions: () => request<SubscriptionImport>("POST", "/api/subscriptions/import", {}),
  saveSubscriptions: (command: SubscriptionCommand) =>
    request<SubscriptionPortfolio>("PUT", "/api/subscriptions", command),
  subscriptionAdvice: (
    serviceId: string,
    expectedRevision: number,
    fresh = false,
    researchQuery?: string,
    signal?: AbortSignal,
  ) =>
    request<SubscriptionAdvice>(
      "POST",
      "/api/subscriptions/review",
      {
        serviceId,
        expectedRevision,
        ...(fresh ? { fresh: true } : {}),
        ...(researchQuery ? { researchQuery } : {}),
      },
      signal,
    ),
  subscriptionReviews: (revision: number, signal?: AbortSignal) =>
    request<{ reviews: SavedSubscriptionReview[] }>(
      "GET",
      `/api/subscriptions/reviews?revision=${revision}&history=true`,
      undefined,
      signal,
    ),
  startReviewBatch: (expectedRevision: number, retry = false) =>
    request<import("../shared/subscriptions").SubscriptionReviewBatch>(
      "POST",
      "/api/subscriptions/review-batch",
      { expectedRevision, retry },
    ),
  reviewBatch: (revision: number, signal?: AbortSignal) =>
    request<import("../shared/subscriptions").SubscriptionReviewBatch>(
      "GET",
      `/api/subscriptions/review-batch?revision=${revision}`,
      undefined,
      signal,
    ),
  paypalLogin: () =>
    request<import("../shared/paypal-identity").PayPalSignIn>("POST", "/api/auth/paypal", {}),
  paypalDemoLogin: async () => {
    await request<{ demo: true; environment: "sandbox" }>("POST", "/api/auth/paypal/demo", {});
    return remember(await request<SessionView>("GET", "/api/session"));
  },
  session: async () => remember(await request<SessionView>("GET", "/api/session")),
  async login(command: LoginCommand) {
    const result = await request<LoginResult>("POST", "/api/session", command);
    remember(result.session);
    return result;
  },
  logout: async () => remember(await request<SessionView>("DELETE", "/api/session", {})),
  recover: async (recoveryCode: string) =>
    remember(await request<SessionView>("POST", "/api/owner/recover", { recoveryCode })),

  cases: () => request<CaseSummary[]>("GET", "/api/cases"),
  createCase: (command: CreateCaseCommand) => request<CaseSnapshot>("POST", "/api/cases", command),
  snapshot: (caseId: string) => request<CaseSnapshot>("GET", `/api/cases/${caseId}`),
  catalogue: (signal?: AbortSignal) => request<CatalogueResponse>("GET", "/api/catalogue", undefined, signal),
  evidence: (caseId: string) => request<Evidence[]>("GET", `/api/cases/${caseId}/evidence`),
  startSetup: (caseId: string) =>
    request<ApprovalResult | AsyncCommandResult>("POST", `/api/cases/${caseId}/setup-subscription`, {}),
  reconcile: (caseId: string) => request<AsyncCommandResult>("POST", `/api/cases/${caseId}/reconcile`, {}),
  returnFromPaypal: (flow: "setup" | "transition", caseId: string, command: ReturnCommand) =>
    request<AsyncCommandResult>(
      "POST",
      `/api/cases/${caseId}/${flow === "setup" ? "setup-subscription" : "checkout"}/return`,
      command,
    ),
  async artifact(artifactId: string) {
    const response = await fetch(`/api/artifacts/${artifactId}`);
    return response.ok ? response.text() : "Artifact unavailable.";
  },

  draftPolicy: (caseId: string, purpose: string) =>
    request<PolicyDraft>("POST", `/api/cases/${caseId}/policy-draft`, { purpose }),
  putPolicy: (caseId: string, policy: PolicyFields, expectedRevision: number) =>
    request<Policy>("PUT", `/api/cases/${caseId}/policy`, { policy, expectedRevision }),
  check: (caseId: string, expectedPolicyRevision: number) =>
    request<AsyncCommandResult>("POST", `/api/cases/${caseId}/check`, { expectedPolicyRevision }),
  whatIf: (caseId: string, command: WhatIfCommand) =>
    request<WhatIfResult>("POST", `/api/cases/${caseId}/what-if`, command),
  applyEvent: (caseId: string, scenario: CaseSnapshot["case"]["scenario"]) =>
    request<AsyncCommandResult>("POST", `/api/cases/${caseId}/scenario`, { scenario }),
  preview: (caseId: string, recommendationId: string) =>
    request<PurchasePreview>("POST", `/api/cases/${caseId}/preview`, { recommendationId }),
  consent: (caseId: string, command: ConsentCommand) =>
    request<Consent>("POST", `/api/cases/${caseId}/consents`, command),
  decline: (caseId: string) => request<CaseSnapshot>("POST", `/api/cases/${caseId}/decline`, {}),
  checkout: (caseId: string, consentId: string) =>
    request<ApprovalResult | AsyncCommandResult>("POST", `/api/cases/${caseId}/checkout`, { consentId }),
  exitReview: (caseId: string, transitionId: string) =>
    request<ExitReview>("POST", `/api/cases/${caseId}/exit-review`, { transitionId }),
  authorizeExits: (caseId: string, review: ExitReview) =>
    request<ExitAuthorization>("POST", `/api/cases/${caseId}/exit-authorizations`, {
      reviewId: review.id,
      reviewHash: review.reviewHash,
      approveRemainingExits: true,
    }),
  pauseExits: (caseId: string, transitionId: string) =>
    request<CaseSnapshot>("POST", `/api/cases/${caseId}/pause-exits`, { transitionId }),
  retry: (caseId: string, operationId: string) =>
    request<AsyncCommandResult>("POST", `/api/cases/${caseId}/retry`, { operationId }),

  setFault: (
    caseId: string,
    fault: "price_change" | "output_failure" | "import_failure" | "timeout",
    enabled: boolean,
  ) => request<CaseSnapshot>("POST", `/api/admin/cases/${caseId}/fault`, { fault, enabled }),
  cleanup: (operationId: string, command: CleanupCommand) =>
    request<AsyncCommandResult>("POST", `/api/admin/operations/${operationId}/cleanup`, command),
  probeOperations: () => request<Operation[]>("GET", "/api/admin/operations"),
  probeSubscription: (caseId: string, providerId: "provider_a" | "provider_b") =>
    request<ApprovalResult | AsyncCommandResult>(
      "POST",
      `/api/admin/cases/${caseId}/probe-subscription/${providerId}`,
      {},
    ),
  probeCancel: (operationId: string) =>
    request<Operation>("POST", `/api/admin/operations/${operationId}/probe-cancel`, {}),
};
