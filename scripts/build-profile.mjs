import { spawnSync } from "node:child_process";
const profile = process.argv[2];
if (!["public", "judge"].includes(profile)) throw new Error("Choose public or judge.");
// Compatibility command only: deployment profiles use the same main client artifact.
const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
process.exitCode = result.status ?? 1;
