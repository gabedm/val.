import type { Config } from "./config";
import type { Database } from "./db";
import type { PaypalClients } from "./paypal";
import type { PlanMapping } from "./plans";
import type { ModelClient } from "./responses-loop";
import type { WalletRuntime } from "./paypal-wallet-runtime";

/** Everything a request or job needs; built once at startup (or per test). */
export interface AppContext {
  db: Database;
  config: Config;
  paypal: PaypalClients;
  planMapping: PlanMapping;
  /** Null when no model key is configured; unavailable work reports review. */
  model: ModelClient | null;
  /** Optional low-latency conversation model; research retains the primary model. */
  conversationModel?: ModelClient | null;
  worker?: { generation: number; revision: string };
  /** Injectable transport; customer/model input cannot choose browser code or API endpoints. */
  walletRuntime?: WalletRuntime;
  switchRuntime?: import("./switch-runtime").SwitchRuntime;
  /** Server-owned execution scope; never selected by a request or model. */
  switchContextForOwner?: (ownerId: string) => Promise<AppContext | undefined>;
}
