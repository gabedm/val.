import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

// The bundled Windows stop uses taskkill, which leaves PostgreSQL 18 IO children
// holding inherited sockets/pipes. pg_ctl waits for the cluster to shut down.
class WindowsPostgres extends EmbeddedPostgres {
  private running = false;
  private stopping?: Promise<void>;

  private async control(args: string[]) {
    const packageName = "@embedded-postgres/windows-x64";
    const { pg_ctl } = (await import(packageName)) as { pg_ctl: string };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pg_ctl, ["-D", this.options.databaseDir, "-w", "-t", "30", ...args], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`pg_ctl ${args.at(-1)} failed (${code}); see ${this.options.databaseDir}/server.log`),
            ),
      );
    });
  }

  override async start() {
    await this.control([
      "-l",
      join(this.options.databaseDir, "server.log"),
      "-o",
      `-p ${this.options.port} -h 127.0.0.1`,
      "start",
    ]);
    this.running = true;
  }

  override async createDatabase(name: string) {
    if (!this.running) throw new Error("PostgreSQL is not running");
    const client = this.getPgClient("postgres", "127.0.0.1");
    try {
      await client.connect();
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
    } finally {
      await client.end();
    }
  }

  override async stop() {
    if (this.stopping) return this.stopping;
    if (!this.running) return;
    this.stopping = (async () => {
      await this.control(["-m", "fast", "stop"]);
      this.running = false;
      if (this.options.persistent === false)
        await rm(this.options.databaseDir, { recursive: true, force: true });
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }
}

export const LocalPostgres = process.platform === "win32" ? WindowsPostgres : EmbeddedPostgres;
