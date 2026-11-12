import { sql } from "drizzle-orm";
import type { RequestHandler } from "express";
import { keyedHash } from "./auth";
import type { AppContext } from "./context";
import { judgeDemoCounters } from "./db/schema";
import { HttpError } from "./http";

export const httpLimits = { perIpMinute: 120, globalMinute: 1000, inFlight: 32 };
/** Protect session creation, password hashing, webhook verification and AI endpoints before expensive work. */
export function requestLimits(ctx: AppContext): RequestHandler {
  let active = 0,
    requests = 0;
  return async (req, res, next) => {
    if (ctx.config.httpRequestLimits === false) return next();
    if (active >= httpLimits.inFlight)
      throw new HttpError(503, "server_busy", "Val is busy. Please try again shortly.");
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.once("finish", release);
    res.once("close", release);
    const now = new Date(),
      cutoff = new Date(now.getTime() - 60_000);
    const counts = await ctx.db.transaction(async (tx) => {
      const counts: number[] = [];
      for (const key of ["http:global", `http:ip:${keyedHash(ctx.config, req.ip ?? "unknown")}`]) {
        const [row] = await tx
          .insert(judgeDemoCounters)
          .values({ key, calls: 1, windowStartedAt: now })
          .onConflictDoUpdate({
            target: judgeDemoCounters.key,
            set: {
              calls: sql`case when ${judgeDemoCounters.windowStartedAt}<${cutoff} then 1 else least(${judgeDemoCounters.calls}+1,100000) end`,
              windowStartedAt: sql`case when ${judgeDemoCounters.windowStartedAt}<${cutoff} then ${now} else ${judgeDemoCounters.windowStartedAt} end`,
            },
          })
          .returning({ calls: judgeDemoCounters.calls });
        counts.push(row!.calls);
      }
      return counts;
    });
    if (++requests % 100 === 0)
      await ctx.db
        .delete(judgeDemoCounters)
        .where(
          sql`${judgeDemoCounters.key} like 'http:%' and ${judgeDemoCounters.windowStartedAt}<${new Date(now.getTime() - 3_600_000)}`,
        );
    if (counts[0]! > httpLimits.globalMinute || counts[1]! > httpLimits.perIpMinute) {
      res.set("Retry-After", "60");
      throw new HttpError(429, "request_rate_limited", "Too many requests. Please try again in a minute.");
    }
    next();
  };
}
