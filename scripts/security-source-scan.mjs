import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const history = process.argv.includes("--history");
const bundleArgument = process.argv.find((argument) => argument.startsWith("--bundle-dir="));
const bundleDirectory = bundleArgument?.slice("--bundle-dir=".length) ?? "dist";
if (bundleArgument && (!bundleDirectory || !existsSync(bundleDirectory)))
  throw new Error("The requested bundle directory does not exist.");
const secretName =
  /(?:API[_-]?KEY|CLIENT[_-]?SECRET|(?:SESSION|DATA)[_-]?SECRET|PASSWORD(?:[_-]?HASH)?|(?:ACCESS|REFRESH|ID)[_-]?TOKEN|PRIVATE[_-]?KEY|RECOVERY[_-]?CODE|DATABASE[_-]?URL)$/i;
const knownSecrets = new Set();

function collectSecrets(configuration) {
  if (!configuration || typeof configuration !== "object") return;
  for (const [name, value] of Object.entries(configuration)) {
    if (name === "WALLET_ENCRYPTION_KEYS" && typeof value === "string" && value.trim()) {
      try {
        for (const secret of Object.values(JSON.parse(value)))
          if (typeof secret === "string" && secret.length >= 16) knownSecrets.add(secret);
      } catch {
        throw new Error("Could not read wallet encryption key configuration. No contents were printed.");
      }
    } else if (secretName.test(name) && typeof value === "string" && value.length >= 16)
      knownSecrets.add(value);
    else if (value && typeof value === "object") collectSecrets(value);
  }
}

collectSecrets(process.env);
// Read ignored local configuration without changing the environment of the scan.
for (const directory of [".", "private"]) {
  if (!existsSync(directory)) continue;
  for (const name of readdirSync(directory)) {
    if (!(name === ".env" || name.endsWith(".env") || name.startsWith(".env.")) || name.endsWith(".example"))
      continue;
    const file = join(directory, name);
    if (lstatSync(file).isFile()) collectSecrets(parseEnv(readFileSync(file, "utf8")));
  }
}
for (const file of [
  "private/entry-ui-state.json",
  "private/owner-access.json",
  "private/wallet-test-login.json",
  "private/sandbox-judge-preview-state.json",
  "private/google-cloud-auth/application_default_credentials.json",
  "private/val-cloud-database-bootstrap.json",
  "private/val-cloud-access.json",
]) {
  if (!existsSync(file)) continue;
  try {
    collectSecrets(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error(`Could not read local credential configuration: ${file}. No contents were printed.`);
  }
}

// Shared JavaScript/Git ERE patterns deliberately avoid matching placeholder key names.
const patterns = [
  "sk-((proj|svcacct)-[A-Za-z0-9_-]{24,}|[A-Za-z0-9]{48})",
  "sk-ant-[A-Za-z0-9_-]{40,}",
  "gh[pousr]_[A-Za-z0-9]{36,}",
  "github_pat_[A-Za-z0-9_]{60,}",
  "AKIA[0-9A-Z]{16}",
  "AIza[0-9A-Za-z_-]{35}",
  "ya29\\.[A-Za-z0-9_-]{20,}",
  "1//[A-Za-z0-9_-]{40,}",
  "-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
];
const tokenPattern = new RegExp(patterns.join("|"));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
  windowsHide: true,
})
  .split("\0")
  .filter(Boolean);
const bundleFiles = [];

function visit(directory) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new Error("Bundle scan refused a symbolic link.");
    if (info.isDirectory()) visit(file);
    else if (info.isFile()) bundleFiles.push(file);
  }
}
visit(bundleDirectory);

const findings = [];
let workingFiles = 0;
for (const file of new Set([...files, ...bundleFiles])) {
  if (!existsSync(file)) continue;
  const info = lstatSync(file);
  if (info.isSymbolicLink()) throw new Error("Source scan refused a symbolic link.");
  if (!info.isFile()) continue;
  workingFiles++;
  const content = readFileSync(file);
  if (
    [...knownSecrets].some((secret) => content.includes(Buffer.from(secret))) ||
    tokenPattern.test(content.toString("utf8"))
  ) {
    findings.push({ scope: "working-tree-or-bundle", file });
  }
}

let historyCommits = 0;
if (history) {
  const refs = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8", windowsHide: true })
    .trim()
    .split("\n")
    .filter(Boolean);
  historyCommits = refs.length;
  for (let index = 0; index < refs.length; index += 50) {
    const batch = refs.slice(index, index + 50);
    const scans = [
      { kind: "known-secret", args: ["-F", "-f", "-"], input: [...knownSecrets].join("\n") },
      { kind: "key-pattern", args: ["-E", "-e", patterns.join("|")] },
    ];
    for (const scan of scans) {
      if (scan.kind === "known-secret" && !knownSecrets.size) continue;
      const result = spawnSync("git", ["grep", "-I", "-l", ...scan.args, ...batch, "--"], {
        input: scan.input,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10_000_000,
      });
      if (result.status !== 0 && result.status !== 1)
        throw new Error("History scan failed; no matched content was printed.");
      for (const file of (result.stdout ?? "").trim().split("\n").filter(Boolean))
        findings.push({ scope: `history-${scan.kind}`, file });
    }
  }
}

const report = {
  checkedAt: new Date().toISOString(),
  workingFiles,
  bundleDirectory,
  bundleFiles: bundleFiles.length,
  historyCommits,
  findings,
  limits:
    "Checks configured local secrets and selected credential patterns. Does not inspect compressed archives, unreachable Git objects, arbitrary personal data or every possible third-party credential.",
};
const reportPath = `private/security/source-scan-${history ? "history" : "current"}.json`;
mkdirSync("private/security", { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    workingFiles,
    bundleFiles: bundleFiles.length,
    historyCommits,
    findings: findings.length,
    report: reportPath,
  }),
);
if (findings.length) process.exitCode = 2;
