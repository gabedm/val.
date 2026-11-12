export interface DeploymentCapabilities {
  passwordAccess: boolean;
  financialTools: boolean;
  kernelSwitching?: { environment: "sandbox" | "live"; testOrigins: string[]; preparationOnly?: boolean };
  paypalIdentityEnvironment: "sandbox" | "live";
  paypalWallet?: boolean;
  paypalSandboxDemo?: boolean;
  paypalSandboxDemoEntry?: boolean;
  switchExample?: { company: string };
}
