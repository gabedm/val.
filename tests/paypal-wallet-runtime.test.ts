import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import { expect, it, vi } from "vitest";
import { KernelWalletRuntime, walletViewerUrl } from "../src/server/paypal-wallet-runtime";
import { paypalWalletDestination } from "../src/client/PayPalIngestion";

const config = {
  apiKey: "synthetic-wallet-key",
  environment: "sandbox" as const,
  maxConcurrent: 2,
  dailyImports: 10,
};
const origin = "https://www.sandbox.paypal.com";
const scope = { start: "2024-10-21", end: "2026-10-21" };
const cells = ["21/10/2026 14:35", "21/10/2024 - 21/10/2026 Until 14:35", "CSV", "Ready"];
const marker = Buffer.from(JSON.stringify([cells[0], "21/10/2024 - 21/10/2026", "CSV"])).toString(
  "base64url",
);
const htmlRow = {
  innerText: cells.join(" "),
  querySelectorAll: (selector: string) =>
    selector === "td"
      ? cells.map((innerText) => ({ innerText }))
      : [{ textContent: "Download", disabled: false, getAttribute: () => null }],
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const hiddenControl: any = {
  waitFor: async () => {},
  isVisible: async () => false,
  filter: () => hiddenControl,
  first: () => hiddenControl,
};

it("validates short browser capabilities and rejects foreign hosts, browser IDs and JWTs at the client boundary", () => {
  const jwt =
    "x." +
    Buffer.from(JSON.stringify({ session: { id: "browser", liveSlug: "SecretSlug12" } })).toString(
      "base64url",
    ) +
    ".x";
  const result = walletViewerUrl(
    "https://prod-iad-hypeman-1.kernel.sh:8443/browser/live?jwt=" + jwt,
    "browser",
  );
  expect(result).toBe("https://prod-iad-hypeman-1.kernel.sh:8443/browser/live/SecretSlug12?readOnly=false");
  expect(paypalWalletDestination(result)).toBe(result);
  for (const url of [
    "https://example.test/browser/live/SecretSlug12?readOnly=false",
    result + "&leak=true",
    result.replace("https:", "http:"),
  ])
    expect(() => paypalWalletDestination(url)).toThrow();
  expect(() =>
    walletViewerUrl("https://prod-iad-hypeman-1.kernel.sh:8443/browser/live?jwt=" + jwt, "other"),
  ).toThrow();
});

it("runs the actual embedded report script against loaded native rows and returns stable opaque report markers", async () => {
  const page: any = {
    url: () => origin + "/reports/accountStatements",
    reload: async () => {},
    getByRole: () => hiddenControl,
    getByText: () => hiddenControl,
    waitForTimeout: async () => {},
    locator: (selector: string) => (selector === "table" ? { waitFor: async () => {} } : rows),
  };
  const rows: any = {
    evaluateAll: (fn: (elements: unknown[], arg?: unknown) => unknown, arg?: unknown) => fn([htmlRow], arg),
  };
  const transport: typeof fetch = async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api.onkernel.com\/browsers\/browser\/playwright\/execute$/);
    expect(init?.redirect).toBe("error");
    const { code } = JSON.parse(String(init?.body));
    return Response.json({ success: true, result: await new AsyncFunction("page", code)(page) });
  };
  expect(await new KernelWalletRuntime(config, transport).reports("browser", scope)).toEqual([
    { marker, ready: true },
  ]);
});

it("does not treat PayPal's table skeleton as an empty report baseline", async () => {
  let waits = 0;
  const skeleton = {
    querySelectorAll: () => [{ innerText: "" }, { innerText: "" }, { innerText: "" }, { innerText: "" }],
  };
  const rows = {
    evaluateAll: (fn: (elements: unknown[], arg?: unknown) => unknown, arg?: unknown) =>
      fn(waits < 5 ? [skeleton] : [htmlRow], arg),
  };
  const page = {
    url: () => origin + "/reports/accountStatements",
    reload: async () => {},
    getByRole: () => hiddenControl,
    getByText: () => hiddenControl,
    locator: () => rows,
    waitForTimeout: async () => {
      waits++;
    },
  };
  const runtime = new KernelWalletRuntime(config, async (_url, init) => {
    const { code } = JSON.parse(String(init?.body));
    return Response.json({ success: true, result: await new AsyncFunction("page", code)(page) });
  });
  expect(await runtime.reports("browser", scope)).toEqual([{ marker, ready: true }]);
  expect(waits).toBeGreaterThanOrEqual(5);
});

it("recognizes a restored signed-in report page without touching sign-in fields", async () => {
  let path = "/reports/accountStatements";
  const page = {
    url: () => origin + path,
    getByRole: (_role: string, { name }: { name: string }) => {
      expect(name).toBe("Activity");
      return {
        count: async () => 1,
        first: () => ({ getAttribute: async () => "/myaccount/transactions/" }),
      };
    },
  };
  const runtime = new KernelWalletRuntime(config, async (_url, init) => {
    const { code } = JSON.parse(String(init?.body));
    return Response.json({ success: true, result: await new AsyncFunction("page", code)(page) });
  });
  expect(await runtime.authenticated("browser")).toBe(true);
  path = "/signin";
  expect(await runtime.authenticated("browser")).toBe(false);
});

it("clicks Create only for the prepared dates and reports a definitive pre-click refusal separately", async () => {
  let end = "11/21/2026";
  const click = vi.fn(async () => {});
  const page = {
    url: () => origin + "/reports/accountStatements",
    locator: (selector: string) => ({
      count: async () => 1,
      inputValue: async () => (selector.endsWith("rangeStart") ? "10/21/2024" : end),
    }),
    getByRole: () => ({ count: async () => 1, isEnabled: async () => true, click }),
  };
  const runtime = new KernelWalletRuntime(config, async (_url, init) => {
    const { code } = JSON.parse(String(init?.body));
    try {
      return Response.json({ success: true, result: await new AsyncFunction("page", code)(page) });
    } catch (error) {
      return Response.json({ success: false, error: String(error) });
    }
  });
  await expect(runtime.submitReport("browser", scope)).rejects.toMatchObject({ code: "not_submitted" });
  expect(click).not.toHaveBeenCalled();
  end = "10/21/2026";
  await runtime.submitReport("browser", scope);
  expect(click).toHaveBeenCalledOnce();
});

it.each([
  { cycle: "month", dates: ["21/08/2026", "21/09/2026", "21/10/2026"] },
  { cycle: "30_days", dates: ["23/07/2026", "22/08/2026", "21/09/2026", "21/10/2026"] },
  { cycle: null, dates: ["21/10/2026"] },
  { cycle: null, dates: ["21/09/2026", "21/10/2026"] },
  { cycle: null, dates: ["21/10/2026"], reference: "" },
])(
  "parses a downloaded statement inside the remote script ($cycle), exports only derived bills, and unlinks even on parser failure",
  async ({ cycle, dates, reference = "I-ABCDEFGHIJKL" }) => {
    let invalid = false,
      deleted = false,
      remoteError: unknown;
    const raw = () =>
      '\uFEFF"Date","Name","Transaction ID","Currency","Gross","Description","Reference Txn ID","From Email Address"\n' +
      dates
        .map((date, i) =>
          [
            date,
            "Spotify AB",
            String(i).padStart(17, "A"),
            "GBP",
            "-12.99",
            "Subscription Payment",
            reference,
            "private@example.test",
          ].join(","),
        )
        .join("\n");
    const fakeFs = {
      lstat: async () => {
        if (deleted) throw Object.assign(new Error(), { code: "ENOENT" });
        return { isFile: () => true, isSymbolicLink: () => false, size: 1000 };
      },
      readFile: async () => Buffer.from(invalid ? "invalid statement" : raw()),
      unlink: async () => {
        deleted = true;
      },
    };
    const client = Object.assign(new EventEmitter(), { send: async () => {}, detach: vi.fn(async () => {}) });
    const target = {
      count: async () => 1,
      click: async () => {
        client.emit("Browser.downloadWillBegin", { guid: "download", suggestedFilename: "statement.csv" });
        client.emit("Browser.downloadProgress", {
          guid: "download",
          state: "completed",
          filePath: "/home/kernel/Downloads/statement.csv",
        });
      },
    };
    const rows: any = {
      evaluateAll: (fn: (elements: unknown[], arg?: unknown) => unknown, arg?: unknown) => fn([htmlRow], arg),
      nth: () => ({ locator: () => ({ nth: () => target }) }),
    };
    const page = {
      url: () => origin + "/reports/accountStatements",
      reload: async () => {},
      getByRole: () => hiddenControl,
      getByText: () => hiddenControl,
      waitForTimeout: async () => {},
      locator: () => rows,
    };
    const transport: typeof fetch = async (_url, init) => {
      const { code } = JSON.parse(String(init?.body));
      const run = new AsyncFunction(
        "page",
        "context",
        "fakeFs",
        "fakeCrypto",
        code
          .replace("await import('node:fs/promises')", "fakeFs")
          .replace("await import('node:crypto')", "fakeCrypto"),
      );
      try {
        return Response.json({
          success: true,
          result: await run(page, { newCDPSession: async () => client }, fakeFs, crypto),
        });
      } catch (error) {
        remoteError = error;
        return Response.json({ success: false, error: String(error) });
      }
    };
    const runtime = new KernelWalletRuntime(config, transport);
    const result = await runtime.readReport("browser", scope, marker, "owner-bound-salt").catch((error) => {
      throw remoteError ?? error;
    });
    const exported = cycle === null ? result.candidates : result.bills;
    if (cycle === null) expect(result.bills).toEqual([]);
    if (cycle === null && !reference) expect(exported).toEqual([]);
    else
      expect(exported).toMatchObject([
        {
          merchant: "Spotify AB",
          amountMinor: 1299,
          cycle,
          agreementStatus: "inferred",
          paymentCount: dates.length,
        },
      ]);
    expect(JSON.stringify(result)).not.toMatch(/private@example|Transaction ID|Bank account/);
    if (exported?.length) expect(exported[0]!.key).toMatch(/^[a-f0-9]{64}$/);
    expect(deleted).toBe(true);
    expect(client.detach).toHaveBeenCalledOnce();
    deleted = false;
    invalid = true;
    await expect(runtime.readReport("browser", scope, marker, "owner-bound-salt")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(deleted).toBe(true);
    expect(client.detach).toHaveBeenCalledTimes(2);
  },
);

it("redacts provider failures and confirms deletion rather than assuming a successful delete response", async () => {
  const runtime = new KernelWalletRuntime(config, async () =>
    Response.json({ secret: "must not appear" }, { status: 500 }),
  );
  await expect(runtime.authenticated("browser")).rejects.toThrow("unavailable");
  const stubborn = new KernelWalletRuntime(config, async () =>
    Response.json({ session_id: "still-present" }),
  );
  await expect(stubborn.deleteBrowser("browser")).rejects.toMatchObject({ code: "unavailable" });
});
