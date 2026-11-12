import { describe, expect, it } from "vitest";
import {
  approvalLink,
  createPaypalClient,
  PaypalApiError,
  UnknownOutcomeError,
  type PaypalSubscription,
} from "../src/server/paypal";

// Scripted fetch for the HTTP client's own rules (hosts, pagination, retries, timeouts).
function scriptedFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetchStub = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/oauth2/token")
      return Response.json({ access_token: "token", expires_in: 3600 });
    requests.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fetchStub, requests };
}

const credentials = { clientId: "client", clientSecret: "secret", webhookId: null };

describe("PayPal client", () => {
  it.each([null, { details: {} }, { details: [null, "unexpected"] }])(
    "keeps malformed error JSON within the normal transient-read recovery path: %j",
    async (payload) => {
      let calls = 0;
      const { fetchStub } = scriptedFetch(() =>
        ++calls === 1 ? Response.json(payload, { status: 503 }) : Response.json({ id: "I-1" }),
      );
      expect(await createPaypalClient(credentials, fetchStub, [0]).getSubscription("I-1")).toMatchObject({
        id: "I-1",
      });
      expect(calls).toBe(2);
    },
  );
  it("refreshes a rejected cached token for a read, without replaying a rejected write", async () => {
    let tokens = 0,
      reads = 0,
      writes = 0;
    const fetchStub = (async (input: string | URL, init: RequestInit = {}) => {
      if (new URL(String(input)).pathname === "/v1/oauth2/token")
        return Response.json({ access_token: `token-${++tokens}`, expires_in: 3600 });
      if (init.method === "POST") {
        writes++;
        return Response.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 });
      }
      reads++;
      return new Headers(init.headers).get("authorization") === "Bearer token-1"
        ? Response.json({ name: "AUTHENTICATION_FAILURE" }, { status: 401 })
        : Response.json({ id: "I-1" });
    }) as typeof fetch;
    const client = createPaypalClient(credentials, fetchStub, []);
    await expect(client.createSubscription({}, "same-request")).rejects.toMatchObject({ httpStatus: 401 });
    expect(writes).toBe(1);
    expect(await client.getSubscription("I-1")).toMatchObject({ id: "I-1" });
    expect(await client.getSubscription("I-1")).toMatchObject({ id: "I-1" });
    expect(tokens).toBe(2);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  it("refreshes a revoked token once during the same read", async () => {
    let tokens = 0,
      reads = 0;
    const fetchStub = (async (input: string | URL) => {
      if (new URL(String(input)).pathname === "/v1/oauth2/token")
        return Response.json({ access_token: `token-${++tokens}`, expires_in: 3600 });
      return ++reads === 1 ? new Response("{}", { status: 401 }) : Response.json({ id: "I-1" });
    }) as typeof fetch;
    expect(await createPaypalClient(credentials, fetchStub, []).getSubscription("I-1")).toMatchObject({
      id: "I-1",
    });
    expect(tokens).toBe(2);
    expect(reads).toBe(2);
  });
  it("requests the subscriber's effective plan only when the importer asks for it", async () => {
    const { fetchStub, requests } = scriptedFetch(() => Response.json({ id: "I-1" }));
    const client = createPaypalClient(credentials, fetchStub, []);
    await client.getSubscription("I-1", { includePlan: true });
    await client.getSubscription("I-1");
    expect(requests[0]!.url.searchParams.get("fields")).toBe("plan");
    expect(requests[1]!.url.search).toBe("");
    expect(requests.every((request) => request.init.method === "GET")).toBe(true);
  });
  it("follows transaction pages only within the sandbox API and the same subscription", async () => {
    const { fetchStub, requests } = scriptedFetch((url) =>
      url.searchParams.get("page") === "2"
        ? Response.json({ transactions: [{ id: "T2", time: "2026-10-09T10:00:00Z" }] })
        : Response.json({
            transactions: [{ id: "T1", time: "2026-10-09T09:00:00Z" }],
            links: [{ rel: "next", href: `${url.origin}${url.pathname}?page=2` }],
          }),
    );
    const client = createPaypalClient(credentials, fetchStub, []);
    const transactions = await client.listTransactions(
      "I-1",
      new Date("2026-10-09T08:00:00Z"),
      new Date("2026-10-09T11:00:00Z"),
    );
    expect(transactions.map((transaction) => transaction.id)).toEqual(["T1", "T2"]);
    expect(requests[0]!.url.searchParams.get("start_time")).toBe("2026-10-09T08:00:00.000Z");
  });

  it.each([
    ["a live PayPal host", "https://api-m.paypal.com/v1/billing/subscriptions/I-1/transactions?page=2"],
    [
      "another subscription",
      "https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-2/transactions?page=2",
    ],
    ["a foreign host", "https://evil.example/v1/billing/subscriptions/I-1/transactions?page=2"],
  ])("refuses a pagination link to %s", async (_label, href) => {
    const { fetchStub, requests } = scriptedFetch(() =>
      Response.json({ transactions: [], links: [{ rel: "next", href }] }),
    );
    const client = createPaypalClient(credentials, fetchStub, []);
    await expect(client.listTransactions("I-1", new Date(), new Date())).rejects.toThrow(
      /Unexpected transaction pagination link/,
    );
    expect(requests).toHaveLength(1);
  });

  it("retries a transient read failure but never retries a write", async () => {
    let reads = 0;
    const { fetchStub, requests } = scriptedFetch((url) =>
      url.pathname.endsWith("/I-1") && ++reads === 1
        ? new Response("{}", { status: 503 })
        : Response.json({ id: "I-1" }),
    );
    const client = createPaypalClient(credentials, fetchStub, [0, 0]);
    expect(await client.getSubscription("I-1")).toMatchObject({ id: "I-1" });
    expect(requests).toHaveLength(2);

    const failingWrite = scriptedFetch(() => new Response("{}", { status: 503 }));
    await expect(
      createPaypalClient(credentials, failingWrite.fetchStub, [0, 0]).createSubscription({}, "request-1"),
    ).rejects.toBeInstanceOf(PaypalApiError);
    expect(failingWrite.requests).toHaveLength(1);
  });

  it("treats a timeout or dropped connection as an unknown outcome, not a failure", async () => {
    const { fetchStub } = scriptedFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(
      createPaypalClient(credentials, fetchStub, []).createSubscription({}, "request-1"),
    ).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it("sends the stored PayPal-Request-Id and reuses one access token", async () => {
    const tokens: string[] = [];
    const fetchStub = (async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/oauth2/token") {
        tokens.push("requested");
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      return Response.json({ id: "I-1", request: new Headers(init.headers).get("paypal-request-id") });
    }) as typeof fetch;
    const client = createPaypalClient(credentials, fetchStub, []);
    expect(await client.createSubscription({}, "request-7")).toMatchObject({ request: "request-7" });
    await client.getSubscription("I-1");
    expect(tokens).toHaveLength(1);
  });

  it("reports a 404 as an API error carrying the PayPal name", async () => {
    const { fetchStub } = scriptedFetch(() => Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 }));
    await expect(createPaypalClient(credentials, fetchStub, []).getSubscription("I-1")).rejects.toMatchObject(
      { httpStatus: 404, responseName: "RESOURCE_NOT_FOUND" },
    );
  });
});

describe("approval links", () => {
  const withLink = (href: string): PaypalSubscription => ({
    id: "I-1",
    plan_id: "P-1",
    status: "APPROVAL_PENDING",
    links: [{ rel: "approve", href }],
  });

  it("accepts the HTTPS sandbox approval host", () => {
    expect(
      approvalLink(withLink("https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1")),
    ).toBe("https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1");
  });

  it.each([
    "https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1",
    "http://www.sandbox.paypal.com/x",
    "https://www.sandbox.paypal.com.evil.example/x",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s", (href) => {
    expect(approvalLink(withLink(href))).toBeNull();
  });

  it("returns nothing when PayPal supplies no approve link", () => {
    expect(approvalLink({ id: "I-1", plan_id: "P-1", status: "ACTIVE", links: [] })).toBeNull();
  });
});
