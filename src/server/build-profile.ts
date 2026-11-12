import { eq, sql } from "drizzle-orm";
import type { AppContext } from "./context";
import { applicationDeployment, owners } from "./db/schema";
import { HttpError } from "./http";

export async function bindBuildProfile(ctx: Pick<AppContext, "db" | "config">) {
  const profile = ctx.config.buildProfile ?? "owner";
  const paypalIdentityEnvironment = ctx.config.paypalIdentityEnvironment ?? "sandbox";
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('val-build-profile'))`);
    const [bound] = await tx
      .select()
      .from(applicationDeployment)
      .where(eq(applicationDeployment.id, "primary"));
    if (bound) {
      if (bound.profile !== profile)
        throw new HttpError(
          503,
          "build_profile_mismatch",
          "This database belongs to a different Val build. Configure a separate database.",
        );
      if (bound.paypalIdentityEnvironment !== paypalIdentityEnvironment)
        throw new HttpError(
          503,
          "paypal_environment_mismatch",
          "This database belongs to a different PayPal environment. Configure a separate database.",
        );
      const walletEnvironment = ctx.config.paypalWallet?.environment ?? null;
      if (bound.paypalWalletEnvironment && bound.paypalWalletEnvironment !== walletEnvironment)
        throw new HttpError(
          503,
          "paypal_wallet_environment_mismatch",
          "This database is bound to another PayPal wallet source. Keep its source configured or use a separate database.",
        );
      if (walletEnvironment && !bound.paypalWalletEnvironment)
        await tx
          .update(applicationDeployment)
          .set({ paypalWalletEnvironment: walletEnvironment })
          .where(eq(applicationDeployment.id, "primary"));
      return;
    }
    if (
      (profile !== "owner" || paypalIdentityEnvironment === "live") &&
      (await tx.select({ id: owners.id }).from(owners).limit(1)).length
    )
      throw new HttpError(
        503,
        "build_profile_unbound",
        "Use a fresh database for this Val environment. Existing owner data was preserved.",
      );
    await tx.insert(applicationDeployment).values({
      id: "primary",
      profile,
      paypalIdentityEnvironment,
      paypalWalletEnvironment: ctx.config.paypalWallet?.environment ?? null,
    });
  });
}
