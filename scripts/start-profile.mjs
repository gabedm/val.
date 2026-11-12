import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const profile = process.argv[2];
if (!["public", "judge"].includes(profile)) throw new Error("Choose public or judge.");
const environmentFile = `.env.${profile}.local`;
if (!existsSync(environmentFile))
  throw new Error(
    `Create ${environmentFile} from its example using separate credentials and a fresh database.`,
  );
const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
  env: { ...process.env, VAL_BUILD_PROFILE: profile, VAL_ENV_FILE: environmentFile },
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", () => {
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
