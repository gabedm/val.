import { walletViewerUrl } from "./paypal-wallet-runtime";
import { switchDomain } from "./switch-security";

export interface SwitchControl {
  ref: string;
  role: string;
  label: string;
  type: string;
  options: string[];
}
export interface SwitchPage {
  nonce: string;
  digest: string;
  origin: string;
  text: string;
  controls: SwitchControl[];
  needsUser: boolean;
}
export interface SwitchBrowser {
  id: string;
  url: string;
  profile: string;
}
export type SwitchAction = { kind: "click" | "fill" | "select" | "refresh"; ref: string; text: string };
export interface SwitchRuntime {
  create(name: string, startUrl: string, paymentOrigin: string, salt: string): Promise<SwitchBrowser>;
  observe(browser: SwitchBrowser): Promise<SwitchPage>;
  act(browser: SwitchBrowser, page: SwitchPage, action: SwitchAction, commit: boolean): Promise<void>;
  handoff(browser: SwitchBrowser): Promise<void>;
  cleanup(browser: SwitchBrowser): Promise<void>;
}
export class SwitchRuntimeError extends Error {
  constructor(readonly code: "unavailable" | "page_changed" | "blocked_action") {
    super(code);
  }
}

// The same fixed redactor is exercised locally and embedded in the remote browser tools.
export const switchRedactionScript = String.raw`
 const reference=value=>'ref_'+crypto.createHmac('sha256',state.salt).update(value).digest('hex').slice(0,16);
 const redact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim()
   .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]')
   .replace(/(\b(?:subscription|membership|order|account|reference|agreement)(?: id| number| ref)?[:#]?\s+)([A-Za-z0-9][A-Za-z0-9-]{5,})/gi,(all,prefix,id)=>/[0-9-]/.test(id)||/^[A-Z0-9]+$/.test(id)?prefix+reference(id):all)
   .replace(/\b(?=[A-Za-z0-9-]{8,}\b)(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g,value=>/^20\d{2}-\d{2}-\d{2}$/.test(value)?value:reference(value))
   .replace(/\b(?:\d[ -]?){8,}\b/g,value=>/^20\d{2}-\d{2}-\d{2}$/.test(value.trim())?value:'[number]');
`;

// Fixed browser tools run in the KERNEL VM. The model supplies observed references, never JavaScript.
const browserTools = `
 const crypto=await import('node:crypto');
 const state=context.__valSwitch;
 if(!state)throw Error('SWITCH_UNAVAILABLE');
 const allowed=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.origin===state.paymentOrigin||u.hostname===state.domain||u.hostname.endsWith('.'+state.domain))}catch{return false}};
 ${switchRedactionScript}
 const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const read=async()=>{
   if(!allowed(page.url()))throw Error('SWITCH_BLOCKED');
   if(new URL(page.url()).origin===state.paymentOrigin)return {nonce:'',digest:'',origin:state.paymentOrigin,text:'Payment approval needs the user.',controls:[],needsUser:true};
   const content=await page.evaluate(()=>{
     const visible=e=>!!(e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden';
     const needsUser=[...document.querySelectorAll('input')].some(e=>visible(e)&&(e.type==='password'||e.autocomplete==='one-time-code'))||!!document.querySelector('iframe[src*="captcha"],iframe[title*="challenge"]');
     if(needsUser)return {text:'Sign-in or verification needs the user.',controls:[],needsUser:true};
     const copy=document.body.cloneNode(true);for(const el of copy.querySelectorAll('script,style,input,textarea,iframe,[autocomplete^="cc-"],[data-private]'))el.remove();
     for(const el of copy.querySelectorAll('p,section,div,h1,h2,h3,br,li,tr,td,th'))el.append(document.createTextNode(' '));
     const controls=[...document.querySelectorAll('a[href],button,input:not([type="hidden"]),select,[role="button"]')].filter(visible).slice(0,100).map((e,index)=>{
       const ref=String(index);e.setAttribute('data-val-switch-ref',ref);
       const label=e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.innerText||e.getAttribute('title')||e.getAttribute('name')||'';
       return {ref,role:e.getAttribute('role')||e.tagName.toLowerCase(),label:label.slice(0,180),type:e.getAttribute('type')||'',options:e.tagName==='SELECT'?[...e.options].map(o=>o.text).slice(0,30):[],target:[e.href,e.formAction,e.form?.action,e.getAttribute('onclick'),e.name,e.disabled,e.form?JSON.stringify([...new FormData(e.form)].map(([k,v])=>[k,typeof v==='string'?v:v.name])):''].join('|')};
     });
     return {text:copy.innerText||copy.textContent||'',controls,needsUser:false};
   });
   const result={origin:new URL(page.url()).origin,text:redact(content.text).slice(0,18000),controls:content.controls.map(({target,...c})=>({...c,label:redact(c.label),options:c.options.map(redact)})),needsUser:content.needsUser};
   const snap={...result,nonce:crypto.randomBytes(16).toString('hex'),digest:digest({result,url:page.url(),targets:content.controls.map(c=>c.target)})};
   state.last={...snap,url:page.url()};return snap;
 };
`;

export class KernelSwitchRuntime implements SwitchRuntime {
  constructor(
    private readonly config: { apiKey: string; preparationOnly?: boolean },
    private readonly transport: typeof fetch = fetch,
  ) {}
  private async request(method: string, path: string, body?: unknown, missing = false) {
    let response: Response;
    try {
      response = await this.transport("https://api.onkernel.com" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
        headers: { Authorization: "Bearer " + this.config.apiKey, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new SwitchRuntimeError("unavailable");
    }
    if (response.status === 404 && missing) return null;
    if (!response.ok) throw new SwitchRuntimeError("unavailable");
    return response.status === 204 ? {} : ((await response.json()) as Record<string, any>);
  }
  private async execute<T>(browser: SwitchBrowser, code: string): Promise<T> {
    const response = await this.request(
      "POST",
      `/browsers/${encodeURIComponent(browser.id)}/playwright/execute`,
      { code, timeout_sec: 30 },
    );
    if (response?.success !== true)
      throw new SwitchRuntimeError(
        String(response?.error).includes("SWITCH_CHANGED")
          ? "page_changed"
          : String(response?.error).includes("SWITCH_BLOCKED")
            ? "blocked_action"
            : "unavailable",
      );
    return response.result as T;
  }
  async create(name: string, startUrl: string, paymentOrigin: string, salt: string) {
    const profile =
      (await this.request("GET", "/profiles/" + encodeURIComponent(name), undefined, true)) ??
      (await this.request("POST", "/profiles", { name }));
    const result =
      (await this.request("GET", "/browsers/" + encodeURIComponent(name), undefined, true)) ??
      (await this.request("POST", "/browsers", {
        name,
        headless: false,
        stealth: false,
        timeout_seconds: 900,
        profile: { id: profile!.id, save_changes: true },
        telemetry: { enabled: false },
      }));
    if (!result?.session_id || !profile?.id) throw new SwitchRuntimeError("unavailable");
    const browser = {
      id: String(result.session_id),
      profile: String(profile.id),
      url: walletViewerUrl(result.browser_live_view_url, String(result.session_id)),
    };
    try {
      await this.execute(
        browser,
        `
        if(context.__valSwitch)return true;
        context.__valSwitch={domain:${JSON.stringify(switchDomain(startUrl))},paymentOrigin:${JSON.stringify(paymentOrigin)},salt:${JSON.stringify(salt)},writeUntil:0,writes:0,human:false,last:null};
        const state=context.__valSwitch;
        await context.route('**/*',async route=>{
          const request=route.request();let u;try{u=new URL(request.url())}catch{return route.abort()}
          if(!['https:','data:','blob:'].includes(u.protocol)||/^(?:localhost|.*\\.local|\\[|\\d+(?:\\.\\d+){3}$)/i.test(u.hostname))return route.abort();
          const own=u.hostname===state.domain||u.hostname.endsWith('.'+state.domain),payment=u.origin===state.paymentOrigin;
          if(request.isNavigationRequest()&&!own&&!payment)return route.abort();
          if(!['GET','HEAD','OPTIONS'].includes(request.method())&&!state.human){
            if(!(Date.now()<state.writeUntil&&state.writes===1&&own))return route.abort();
            state.writes=0;
          }
          return route.continue();
        });
        await page.goto(${JSON.stringify(startUrl)},{waitUntil:'domcontentloaded',timeout:20000});return true;
      `,
      );
      return browser;
    } catch (error) {
      throw error;
    }
  }
  async observe(browser: SwitchBrowser) {
    return this.execute<SwitchPage>(
      browser,
      browserTools + `state.human=false;state.writeUntil=0;state.writes=0;return await read();`,
    );
  }
  async handoff(browser: SwitchBrowser) {
    await this.execute(
      browser,
      `if(!context.__valSwitch)throw Error('SWITCH_UNAVAILABLE');context.__valSwitch.human=true;return true;`,
    );
  }
  async act(browser: SwitchBrowser, snapshot: SwitchPage, action: SwitchAction, commit: boolean) {
    if (commit && this.config.preparationOnly) throw new SwitchRuntimeError("blocked_action");
    await this.execute(
      browser,
      browserTools +
        `
      const expected=${JSON.stringify({ nonce: snapshot.nonce, digest: snapshot.digest })},action=${JSON.stringify(action)},commit=${JSON.stringify(commit)};
      const last=state.last;if(!last||last.nonce!==expected.nonce||last.digest!==expected.digest)throw Error('SWITCH_CHANGED');
      const current=await read();if(current.digest!==expected.digest||page.url()!==last.url)throw Error('SWITCH_CHANGED');
      if(action.kind==='refresh'){
        if(commit)throw Error('SWITCH_BLOCKED');state.last=null;state.human=false;state.writeUntil=0;state.writes=0;
        await page.goto(last.url,{waitUntil:'domcontentloaded',timeout:20000});return true;
      }
      const control=current.controls.find(c=>c.ref===action.ref);if(!control)throw Error('SWITCH_CHANGED');
      if(/password|email|card|cvv|cvc|cc[-_ ]|bank|address|phone|verification|one.time|security code|expiry|expiration|iban|routing|sort.code|postal|billing|payment/i.test(control.label+' '+control.type))throw Error('SWITCH_BLOCKED');
      const target=page.locator('[data-val-switch-ref="'+action.ref+'"]');
      if(action.kind==='fill'){
        if(commit||/[@]|(?:\\d[ -]?){8,}/.test(action.text)||!['text','search','number'].includes(control.type))throw Error('SWITCH_BLOCKED');
        await target.fill(action.text);
      }else if(action.kind==='select'){
        if(commit||!control.options.includes(action.text))throw Error('SWITCH_BLOCKED');await target.selectOption({label:action.text});
      }else if(action.kind==='click'){
        if(!commit&&control.type==='checkbox')throw Error('SWITCH_BLOCKED');
        state.last=null;state.human=false;state.writeUntil=commit?Date.now()+15000:0;state.writes=commit?1:0;
        try{await target.click({timeout:15000});await page.waitForTimeout(1000);}finally{state.writeUntil=0;state.writes=0;}
      }else throw Error('SWITCH_BLOCKED');return true;
    `,
    );
  }
  async cleanup(browser: SwitchBrowser) {
    await this.request("DELETE", "/browsers/" + encodeURIComponent(browser.id), undefined, true);
    await this.request("DELETE", "/profiles/" + encodeURIComponent(browser.profile), undefined, true);
  }
}
