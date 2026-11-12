import { eq } from "drizzle-orm";
import type { AppContext } from "./context";
import type { Executor } from "./db";
import { applicationDeployment } from "./db/schema";

type WorkerContext = Pick<AppContext, "db" | "worker">;

/** A restarted obsolete Cloud Run revision cannot take deployment ownership back. */
export async function activateWorker(db: AppContext["db"], service?: string, revision?: string) {
  if (!service && !revision) return undefined;
  if (!service || !revision?.startsWith(service + "-")) throw new Error("Invalid hosted worker identity");
  const match = revision.slice(service.length + 1).match(/^(\d+)-[a-z0-9]+$/);
  const generation = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647)
    throw new Error("Invalid hosted worker generation");
  await db.transaction(async (tx) => {
    const [bound] = await tx
      .select()
      .from(applicationDeployment)
      .where(eq(applicationDeployment.id, "primary"))
      .for("update");
    if (!bound) throw new Error("Bind the database profile before activating a worker");
    if (bound.workerRevision && bound.workerRevision.replace(/-\d+-[a-z0-9]+$/, "") !== service)
      throw new Error("This database belongs to another hosted worker service");
    if (
      bound.workerGeneration === null ||
      bound.workerGeneration < generation ||
      bound.workerRevision === revision
    )
      await tx
        .update(applicationDeployment)
        .set({ workerGeneration: generation, workerRevision: revision })
        .where(eq(applicationDeployment.id, "primary"));
  });
  return { generation, revision };
}

/** Transaction callers hold the fence through their claim or funding decision. */
export async function currentWorker(ctx: WorkerContext, transaction?: Executor) {
  const query = (transaction ?? ctx.db)
    .select({
      generation: applicationDeployment.workerGeneration,
      revision: applicationDeployment.workerRevision,
    })
    .from(applicationDeployment)
    .where(eq(applicationDeployment.id, "primary"));
  const [active] = transaction ? await query.for("share") : await query;
  if (!ctx.worker) return !active?.revision;
  return active?.generation === ctx.worker.generation && active?.revision === ctx.worker.revision;
}
