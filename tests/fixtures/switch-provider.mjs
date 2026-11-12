/** Isolated provider used for real-browser acceptance. Never mounted by the Val application. */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG_FILE, "utf8"));
const role = process.env.FIXTURE_ROLE;
if (!["old", "new"].includes(role) || !config[role] || !config.expiresAt || Date.parse(config.expiresAt) <= Date.now()) throw Error("Invalid isolated fixture configuration");
const product = config[role];
let token;
const owned = new Set();
const stats = { creates: 0, cancels: 0, reads: 0 };
const html = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = value => createHmac("sha256", config.sessionKey).update(value).digest("base64url");
function subscriptionCookie(id) { const value = Buffer.from(id).toString("base64url"); return `lab_sub=${value}.${sign(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=14400`; }
function subscriptionId(cookie) {
  const value = cookie?.split("; ").find(v => v.startsWith("lab_sub="))?.slice(8);
  if (!value) return null;
  const [data, mac] = value.split(".");
  return same(sign(data), mac) ? Buffer.from(data, "base64url").toString("utf8") : null;
}
async function paypal(path, method = "GET", body, requestId) {
  if (!token || token.until < Date.now()) {
    const response = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", { method: "POST", headers: { Authorization: "Basic " + Buffer.from(config.clientId + ":" + config.clientSecret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error("Test merchant authentication unavailable");
    const value = await response.json(); token = { value: value.access_token, until: Date.now() + 300000 };
  }
  const response = await fetch("https://api-m.sandbox.paypal.com" + path, { method, headers: { Authorization: "Bearer " + token.value, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error("Test payment request is unresolved");
  return response.status === 204 ? null : response.json();
}
const amount = "£" + (product.amountMinor / 100).toFixed(2);
const terms = `${product.plan}: ${amount} due now, renews monthly at ${amount}. No setup fee. No minimum term. All taxes included.`;
function render(response, title, content) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' https://www.sandbox.paypal.com; frame-ancestors 'none'" });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>${html(title)}</title><style>body{font:17px system-ui;margin:8vh auto;max-width:680px;padding:24px;color:#111;background:${role === "old" ? "#f4f8fc" : "#fcfaf6"}}button,a{font:inherit;color:#114999}button{padding:14px 24px;border-radius:24px;border:1px solid #ccd;background:white}section{padding:24px;border:1px solid #dde;border-radius:20px;margin:24px 0}small{color:#556}</style><small>Isolated provider · PayPal test funds only</small><h1>${html(product.name)}</h1>${content}`);
}
createServer(async (request, response) => {
  try {
    if (Date.now() > Date.parse(config.expiresAt)) { response.writeHead(410); return response.end("Acceptance fixture expired"); }
    const url = new URL(request.url, "https://fixture.invalid");
    const cookie = request.headers.cookie ?? "";
    if (url.pathname === "/enrol") return render(response, "Connect test provider", `<p>Opening your private test provider…</p><script>const value=location.hash.slice(1);if(value)document.cookie='lab_access='+encodeURIComponent(value)+';Secure;SameSite=Lax;Path=/';location.replace('/');</script>`);
    const access = decodeURIComponent(cookie.split("; ").find(v => v.startsWith("lab_access="))?.slice(11) ?? "");
    const admin = same(request.headers.authorization, "Bearer " + config.accessKey);
    if (!admin && !same(access, config.accessKey)) { response.writeHead(401); return response.end("Use the private acceptance link"); }
    if (url.pathname === "/acceptance-status" && admin) { response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return response.end(JSON.stringify({ ...stats, subscriptions: [...owned] })); }
    const origin = "https://" + request.headers.host;
    const id = subscriptionId(cookie);
    const details = id ? await paypal("/v1/billing/subscriptions/" + encodeURIComponent(id)) : null;
    if (details && details.plan_id !== product.planId) throw Error("Unexpected test subscription");
    stats.reads++;
    if (request.method === "GET" && details?.status === "APPROVAL_PENDING") {
      const approval = details.links?.find(link => link.rel === "approve")?.href;
      if (!approval || new URL(approval).origin !== "https://www.sandbox.paypal.com") throw Error("Missing approval continuation");
      return render(response, "Confirm with PayPal", `<section><h2>${html(product.plan)}</h2><p>Subscription ${html(id)} is pending PayPal approval and is not active.</p><p>${html(terms)}</p><a href="${html(approval)}">Continue with PayPal</a></section>`);
    }
    if (request.method === "GET" && url.pathname === "/") {
      if (details?.status === "ACTIVE") return render(response, "Your membership", `<section><h2>${html(product.plan)}</h2><p>Subscription ${html(id)} is active.</p><p>${html(terms)}</p><a href="/${html(product.reviewPath)}">Manage renewal</a></section>`);
      if (details?.status === "CANCELLED") return render(response, "Renewal ended", `<section><p>Subscription ${html(id)} is cancelled. Auto-renewal is off.</p><p>Cancellation effective ${config.effectiveOn}.</p></section>`);
      return render(response, "Choose membership", role === "new" ? `<h2>Take your notes everywhere</h2><p>Offline access, your own library, one person.</p><a href="/${html(product.checkoutPath)}">Explore ${html(product.plan)}</a>` : `<p>No active test membership yet. Set up the disposable baseline to begin acceptance.</p><form action="/${html(product.purchasePath)}" method="post"><button>Set up ${html(product.plan)} for ${amount} / month</button></form>`);
    }
    if (request.method === "GET" && url.pathname === "/" + product.checkoutPath) return render(response, "Review your order", `<section><h2>${html(product.plan)}</h2><p>${html(terms)}</p><form action="/${html(product.purchasePath)}" method="post"><button type="submit">Start my subscription</button></form></section>`);
    if (request.method === "POST" && url.pathname === "/" + product.purchasePath) {
      if (details?.status === "ACTIVE") { response.writeHead(303, { Location: "/" }); return response.end(); }
      const created = await paypal("/v1/billing/subscriptions", "POST", { plan_id: product.planId, custom_id: config.runId + "-" + role, application_context: { brand_name: product.name, user_action: "SUBSCRIBE_NOW", shipping_preference: "NO_SHIPPING", return_url: origin + "/payment-return", cancel_url: origin + "/" } }, config.runId + "-" + role);
      stats.creates++; owned.add(created.id);
      const approval = created.links?.find(link => link.rel === "approve")?.href;
      if (!approval || new URL(approval).origin !== "https://www.sandbox.paypal.com") throw Error("Missing real Sandbox approval");
      response.writeHead(303, { Location: approval, "Set-Cookie": subscriptionCookie(created.id), "Referrer-Policy": "no-referrer" }); return response.end();
    }
    if (request.method === "GET" && url.pathname === "/payment-return") { response.writeHead(303, { Location: "/", "Referrer-Policy": "no-referrer" }); return response.end(); }
    if (request.method === "GET" && url.pathname === "/" + product.reviewPath && details?.status === "ACTIVE") return render(response, "Review cancellation", `<section><h2>${html(product.plan)}</h2><p>Subscription ${html(id)}: cancellation effective ${config.effectiveOn}. No cancellation fee.</p><form method="post" action="/${html(product.cancelPath)}"><button type="submit">End my renewal</button></form></section>`);
    if (request.method === "POST" && url.pathname === "/" + product.cancelPath && details?.status === "ACTIVE" && details.custom_id === config.runId + "-" + role) {
      await paypal("/v1/billing/subscriptions/" + encodeURIComponent(id) + "/cancel", "POST", { reason: "Disposable Val switching acceptance" }); stats.cancels++;
      response.writeHead(303, { Location: "/" }); return response.end();
    }
    response.writeHead(404); response.end("Page not found");
  } catch { response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); response.end("The test provider cannot confirm that request yet. Do not repeat a payment; check its status first."); }
}).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
