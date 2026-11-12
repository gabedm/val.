import type { Config } from "./config";
import { groupStatementPayments, parsePayPalStatement, type StatementScope } from "./paypal-statement";
import type { PayPalWalletBill } from "../shared/paypal-wallet";

export interface WalletBrowser {
  id: string;
  url: string;
}
export interface WalletReport {
  marker: string;
  ready: boolean;
}
export interface WalletRead {
  bills: (PayPalWalletBill & { agreementRef: string | null })[];
  candidates?: (Omit<PayPalWalletBill, "cycle"> & { cycle: null; agreementRef: string })[];
  ledgerRecords: number;
  unresolvedPayments: number;
}
export interface WalletRuntime {
  profile(name: string): Promise<string>;
  browser(name: string, profileId: string): Promise<WalletBrowser>;
  authenticated(browserId: string): Promise<boolean>;
  reports(browserId: string, scope: StatementScope): Promise<WalletReport[]>;
  prepareReport(browserId: string, scope: StatementScope): Promise<void>;
  submitReport(browserId: string, scope: StatementScope): Promise<void>;
  readReport(
    browserId: string,
    scope: StatementScope,
    marker: string,
    ownerSalt: string,
  ): Promise<WalletRead>;
  agreement(browserId: string, reference: string): Promise<"active" | "inactive">;
  deleteBrowser(id: string): Promise<void>;
  deleteProfile(id: string): Promise<void>;
}
export class WalletRuntimeError extends Error {
  constructor(
    readonly code: "auth_required" | "unavailable" | "layout_changed" | "not_found" | "not_submitted",
  ) {
    super(code);
  }
}

const originFor = (environment: "sandbox" | "live") =>
  environment === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";

/** KERNEL capability URLs are credentials: validate their destination and never log them. */
export function walletViewerUrl(value: unknown, browserId: string) {
  if (typeof value !== "string") throw new WalletRuntimeError("unavailable");
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    !/^prod-[a-z0-9-]+\.kernel\.sh$/.test(url.hostname) ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/browser/live")
  )
    throw new WalletRuntimeError("unavailable");
  if (url.searchParams.has("jwt")) {
    try {
      const payload = JSON.parse(
        Buffer.from(url.searchParams.get("jwt")!.split(".")[1]!, "base64url").toString("utf8"),
      ) as { session?: { id?: unknown; liveSlug?: unknown } };
      if (
        payload.session?.id !== browserId ||
        typeof payload.session.liveSlug !== "string" ||
        !/^[a-zA-Z0-9_-]{6,64}$/.test(payload.session.liveSlug)
      )
        throw new Error();
      url.pathname = "/browser/live/" + payload.session.liveSlug;
    } catch {
      throw new WalletRuntimeError("unavailable");
    }
  } else if (!/^\/browser\/live\/[a-zA-Z0-9_-]{6,64}$/.test(url.pathname))
    throw new WalletRuntimeError("unavailable");
  url.search = "readOnly=false";
  url.hash = "";
  return url.href;
}

// These helpers run inside KERNEL; account data stays in that VM.
const reportHelpers = (origin: string, scope: StatementScope) => `
  const expectedOrigin = ${JSON.stringify(origin)};
  const scope = ${JSON.stringify(scope)};
  const guard = () => {
    const url = new URL(page.url());
    if (url.origin !== expectedOrigin || !url.pathname.startsWith('/reports/'))
      throw new Error('WALLET_AUTH_REQUIRED');
  };
  const display = value => value.slice(8, 10) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4);
  const reportRows = () => page.locator('tr:visible');
  const markers = async () => {
    const wantedRange = display(scope.start) + ' - ' + display(scope.end);
    const rows = await reportRows().evaluateAll((elements, wanted) => elements.flatMap((element, rowIndex) => {
      const cells = [...element.querySelectorAll('td')].map(cell => (cell.innerText || cell.textContent || '').trim());
      const range = cells[1]?.split('Until')[0]?.trim();
      if (cells.length < 4 || !cells.includes('CSV') || range !== wanted) return [];
      const buttons = [...element.querySelectorAll('button')];
      const buttonIndex = buttons.findIndex(button =>
        (button.textContent || '').trim() === 'Download' &&
        !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      );
      return [{ identity: [cells[0], range, 'CSV'], ready: buttonIndex >= 0, rowIndex, buttonIndex }];
    }), wantedRange);
    return rows.map(({ identity, ...row }) => ({
      ...row,
      marker: Buffer.from(JSON.stringify(identity)).toString('base64url')
    }));
  };
  const enterReports = async () => {
    const current = new URL(page.url());
    if (current.origin !== expectedOrigin) throw new Error('WALLET_AUTH_REQUIRED');
    const navigation = { waitUntil: 'domcontentloaded', timeout: 18000 };
    if (current.pathname !== '/reports/accountStatements')
      await page.goto(expectedOrigin + '/reports/accountStatements', navigation);
    else await page.reload(navigation);
    guard();
    await page.getByRole('heading', { name: 'Statements - monthly and custom', exact: true })
      .waitFor({ state: 'visible', timeout: 10000 });
    const close = page.getByRole('button', { name: 'close sheet', exact: true });
    if (await close.isVisible()) await close.click();
    // The heading and table skeleton render before PayPal fetches the report rows.
    // An empty skeleton must never become the baseline for an unknown-outcome check.
    const loading = page.getByRole('alert').filter({ hasText: 'loading' }).first();
    const empty = page.getByText(/^(?:There are )?no (?:statements|reports)(?: (?:available|found|yet))?[.!]?$|^You (?:have not|haven.t) (?:created|generated|requested) (?:a |any )?(?:statements?|reports?)(?: yet)?[.!]?$/i).first();
    let loaded = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await reportRows().evaluateAll(elements => elements.filter(element => {
        const cells = [...element.querySelectorAll('td')].map(cell => (cell.innerText || cell.textContent || '').trim());
        return cells.length >= 4 && cells.some(cell => ['CSV', 'PDF', 'TAB', 'QIF', 'OFX', 'QBO', 'IIF'].includes(cell));
      }).length);
      if (!await loading.isVisible() && (rows > 0 || await empty.isVisible())) {
        loaded = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!loaded) throw new Error('WALLET_LAYOUT_CHANGED');
  };
`;

export class KernelWalletRuntime implements WalletRuntime {
  private readonly origin: string;
  constructor(
    private readonly config: NonNullable<Config["paypalWallet"]>,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.origin = originFor(config.environment);
  }
  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeout = 30_000,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.transport("https://api.onkernel.com" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new WalletRuntimeError("unavailable");
    }
    if (response.status === 404) throw new WalletRuntimeError("not_found");
    if (!response.ok) throw new WalletRuntimeError("unavailable");
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text) return {};
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      throw new WalletRuntimeError("unavailable");
    }
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new WalletRuntimeError("unavailable");
    return result as Record<string, unknown>;
  }
  private async execute<T>(browserId: string, code: string, timeout = 25): Promise<T> {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => unknown;
    new AsyncFunction("page", "context", "browser", code);
    const result = await this.request(
      "POST",
      `/browsers/${encodeURIComponent(browserId)}/playwright/execute`,
      { timeout_sec: timeout, code },
      (timeout + 10) * 1000,
    );
    if (result.success !== true) {
      const error = typeof result.error === "string" ? result.error : "";
      throw new WalletRuntimeError(
        error.includes("WALLET_NOT_SUBMITTED")
          ? "not_submitted"
          : error.includes("WALLET_AUTH_REQUIRED")
            ? "auth_required"
            : error.includes("WALLET_LAYOUT_CHANGED")
              ? "layout_changed"
              : "unavailable",
      );
    }
    return result.result as T;
  }
  async profile(name: string) {
    let result: Record<string, unknown>;
    try {
      result = await this.request("GET", "/profiles/" + encodeURIComponent(name));
    } catch (error) {
      if (!(error instanceof WalletRuntimeError) || error.code !== "not_found") throw error;
      result = await this.request("POST", "/profiles", { name });
    }
    if (typeof result.id !== "string") throw new WalletRuntimeError("unavailable");
    return result.id;
  }
  async browser(name: string, profileId: string) {
    let result: Record<string, unknown>;
    try {
      result = await this.request("GET", "/browsers/" + encodeURIComponent(name));
    } catch (error) {
      if (!(error instanceof WalletRuntimeError) || error.code !== "not_found") throw error;
      result = await this.request("POST", "/browsers", {
        name,
        headless: false,
        stealth: false,
        timeout_seconds: 900,
        start_url: this.origin + "/signin",
        profile: { id: profileId, save_changes: true },
        telemetry: { enabled: false },
      });
    }
    if (typeof result.session_id !== "string") throw new WalletRuntimeError("unavailable");
    return { id: result.session_id, url: walletViewerUrl(result.browser_live_view_url, result.session_id) };
  }
  async authenticated(browserId: string) {
    return this.execute<boolean>(
      browserId,
      `
      const expected=${JSON.stringify(this.origin)},url=new URL(page.url());
      if(url.origin!==expected||(!url.pathname.startsWith('/myaccount/')&&!url.pathname.startsWith('/reports/')))return false;
      const link=page.getByRole('link',{name:'Activity',exact:true});
      if(await link.count()===0)return false;
      const href=await link.first().getAttribute('href');if(!href||new URL(href,expected).origin!==expected)return false;
      return true;
    `,
    );
  }
  async reports(browserId: string, scope: StatementScope) {
    return this.execute<WalletReport[]>(
      browserId,
      reportHelpers(this.origin, scope) +
        `
      await enterReports();
      let previous=null;
      for(let attempt=0;attempt<5;attempt++){const result=await markers();const snapshot=JSON.stringify(result);if(snapshot===previous)return result.map(({marker,ready})=>({marker,ready}));previous=snapshot;await page.waitForTimeout(300);}
      throw new Error('WALLET_LAYOUT_CHANGED');
    `,
    );
  }
  async prepareReport(browserId: string, scope: StatementScope) {
    const date = (value: string) => value.slice(5, 7) + value.slice(8, 10) + value.slice(0, 4);
    await this.execute(
      browserId,
      reportHelpers(this.origin, scope) +
        `
      await enterReports();await page.getByRole('button',{name:'Create Report',exact:true}).click();
      await page.locator('#dropdownMenuSelect_Fileformat').selectOption('0');await page.locator('#dropdownMenuSelect_Daterange').selectOption('custom');
      const start=page.locator('#text-input-rangeStart'),end=page.locator('#text-input-rangeEnd');
      const enter=async(field,value)=>{await field.press('ControlOrMeta+A');await field.press('Backspace');await field.pressSequentially(value,{delay:40});await field.press('Tab');};
      await enter(start,${JSON.stringify(date(scope.start))});await enter(end,${JSON.stringify(date(scope.end))});
      if(await start.inputValue()!==${JSON.stringify(date(scope.start).replace(/^(..)(..)(....)$/, "$1/$2/$3"))}||await end.inputValue()!==${JSON.stringify(date(scope.end).replace(/^(..)(..)(....)$/, "$1/$2/$3"))}||await start.getAttribute('aria-invalid')==='true'||await end.getAttribute('aria-invalid')==='true')throw new Error('WALLET_LAYOUT_CHANGED');
      return {prepared:true};
    `,
    );
  }
  async submitReport(browserId: string, scope: StatementScope) {
    const display = (value: string) => value.slice(5, 7) + "/" + value.slice(8, 10) + "/" + value.slice(0, 4);
    await this.execute(
      browserId,
      `
      const url=new URL(page.url());
      if(url.origin!==${JSON.stringify(this.origin)}||url.pathname!=='/reports/accountStatements')throw new Error('WALLET_NOT_SUBMITTED');
      const start=page.locator('#text-input-rangeStart'),end=page.locator('#text-input-rangeEnd'),create=page.getByRole('button',{name:'Create',exact:true});
      if(await start.count()!==1||await end.count()!==1||await create.count()!==1||await start.inputValue()!==${JSON.stringify(display(scope.start))}||await end.inputValue()!==${JSON.stringify(display(scope.end))}||!await create.isEnabled())throw new Error('WALLET_NOT_SUBMITTED');
      await create.click();return {submitted:true};
    `,
    );
  }
  async readReport(browserId: string, scope: StatementScope, marker: string, ownerSalt: string) {
    return this.execute<WalletRead>(
      browserId,
      reportHelpers(this.origin, scope) +
        `
      await enterReports();const reports=await markers();const index=reports.findIndex(report=>report.marker===${JSON.stringify(marker)}&&report.ready);
      if(index<0||reports.filter(report=>report.marker===${JSON.stringify(marker)}).length!==1)throw new Error('WALLET_LAYOUT_CHANGED');
      const target=reportRows().nth(reports[index].rowIndex).locator('button').nth(reports[index].buttonIndex);if(await target.count()!==1)throw new Error('WALLET_LAYOUT_CHANGED');
      const fs=await import('node:fs/promises'),crypto=await import('node:crypto');
      const client=await context.newCDPSession(page);let filePath,timer,guid,filename;
      try{
        await client.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
        const completed=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Statement download timed out.')),20000);client.on('Browser.downloadWillBegin',event=>{if(!guid){guid=event.guid;filename=event.suggestedFilename;}});client.on('Browser.downloadProgress',event=>{if(event.guid!==guid)return;if(event.state==='completed')resolve(event);else if(event.state==='canceled')reject(new Error('Statement download was canceled.'));});});completed.catch(()=>{});
        await target.click();const event=await completed;filePath=event.filePath;
        if(typeof filePath!=='string'||!/^\\/home\\/kernel\\/Downloads\\/[^/]+$/.test(filePath)||! /\\.csv$/i.test(filename||''))throw new Error('Unexpected statement download.');
        const info=await fs.lstat(filePath);if(!info.isFile()||info.isSymbolicLink()||info.size>10*1024*1024)throw new Error('Unsupported statement file.');
        const bytes=await fs.readFile(filePath);const text=bytes.toString(bytes[0]===255&&bytes[1]===254?'utf16le':'utf8');
        const __name=target=>target;
        const parse=${parsePayPalStatement.toString()},group=${groupStatementPayments.toString()};const records=parse(text,scope),result=group(records,scope.end);
        const pack=group=>({key:crypto.createHmac('sha256',${JSON.stringify(ownerSalt)}).update(group.key).digest('hex'),merchant:group.merchant,currency:group.currency,amountMinor:group.amountMinor,cycle:group.cycle,paymentCount:group.paymentCount,lastPaidOn:group.lastPaidOn,agreementStatus:'inferred',agreementRef:group.parent});
        const bills=result.groups.filter(group=>group.cycle).map(pack);
        const candidates=result.groups.filter(group=>!group.cycle&&group.parent&&Date.parse(scope.end)-Date.parse(group.lastPaidOn)>=0&&Date.parse(scope.end)-Date.parse(group.lastPaidOn)<=400*86400000).map(pack);
        return {bills,candidates,ledgerRecords:records.length,unresolvedPayments:result.unresolvedPayments};
      }finally{
        if(timer)clearTimeout(timer);
        if(filePath&&/^\\/home\\/kernel\\/Downloads\\/[^/]+$/.test(filePath)){await fs.unlink(filePath);try{await fs.lstat(filePath);throw new Error('Temporary download remains.');}catch(error){if(error.code!=='ENOENT')throw error;}}
        await client.detach();
      }
    `,
      45,
    );
  }
  async agreement(browserId: string, reference: string) {
    if (!/^[IB]-[A-Z0-9]{10,24}$/.test(reference)) throw new WalletRuntimeError("layout_changed");
    return this.execute<"active" | "inactive">(
      browserId,
      `
      const target=${JSON.stringify(this.origin + "/myaccount/autopay/connect/" + reference)};
      await page.goto(target,{waitUntil:'domcontentloaded',timeout:18000});
      if(new URL(page.url()).origin+new URL(page.url()).pathname!==target)throw new Error('WALLET_AUTH_REQUIRED');
      const status=page.locator('.agreementDetails-info').filter({hasText:/^(ACTIVE|INACTIVE|CANCELLED|CANCELED)$/i}).first();await status.waitFor({state:'visible',timeout:8000});
      return (await status.innerText()).trim().toUpperCase()==='ACTIVE'?'active':'inactive';
    `,
      35,
    );
  }
  private async remove(type: "profiles" | "browsers", id: string) {
    try {
      await this.request("DELETE", `/${type}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!(error instanceof WalletRuntimeError) || error.code !== "not_found") throw error;
    }
    try {
      await this.request("GET", `/${type}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof WalletRuntimeError && error.code === "not_found") return;
      throw error;
    }
    throw new WalletRuntimeError("unavailable");
  }
  deleteBrowser(id: string) {
    return this.remove("browsers", id);
  }
  deleteProfile(id: string) {
    return this.remove("profiles", id);
  }
}
