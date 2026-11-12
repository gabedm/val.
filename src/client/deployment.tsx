import { createContext, useContext } from "react";
import type { DeploymentCapabilities } from "../shared/deployment";

/** One client bundle; the server selects available features. Unknown state exposes no operator controls. */
export const DeploymentContext = createContext<DeploymentCapabilities>({
  passwordAccess: false,
  financialTools: false,
  paypalIdentityEnvironment: "sandbox",
});
export const useDeployment = () => useContext(DeploymentContext);
