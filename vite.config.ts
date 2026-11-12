import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

const clientRoot = fileURLToPath(new URL("./src/client", import.meta.url));

/** Vite exposes these values in browser bundles, including mode-specific environment files. */
export function checkClientEnvironment(mode: string, directory: string): void {
  const environment = { ...loadEnv(mode, directory, ""), ...process.env };
  const sensitiveName = /key|token|secret|password|credential|database_url/i;
  const serverSecrets = Object.entries(environment).flatMap(([name, value]) =>
    !name.startsWith("VITE_") && sensitiveName.test(name) && value && value.length >= 8 ? [value] : [],
  );
  for (const [name, value] of Object.entries(environment)) {
    if (
      name.startsWith("VITE_") &&
      (sensitiveName.test(name) || serverSecrets.some((secret) => value?.includes(secret)))
    ) {
      throw new Error(`Browser environment variable ${name} is reserved for server-side configuration.`);
    }
  }
}

// The dev client proxies API calls to the Express server, which owns cookies and CSRF.
export default defineConfig(({ mode }) => {
  checkClientEnvironment(mode, clientRoot);
  return {
    plugins: [react()],
    root: clientRoot,
    build: { outDir: "../../dist/client", emptyOutDir: true },
    server: { port: 5173, proxy: { "/api/": "http://127.0.0.1:3000", "/logos/": "http://127.0.0.1:3000" } },
  };
});
