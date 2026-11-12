import { databaseTarget, sameDatabase } from "./database-target";

/** Evaluations may create synthetic records only in a separately named evaluation database. */
export function evaluationDatabaseSettings(environment: NodeJS.ProcessEnv) {
  const base = databaseTarget(environment.EVAL_DATABASE_URL ?? environment.DATABASE_URL ?? "");
  const name = environment.EVAL_DATABASE_URL ? base.name : "val_evals";
  if (!/^val_evals(?:_[a-z0-9_]+)?$/.test(name)) {
    throw new Error("EVAL_DATABASE_URL must name val_evals or val_evals_<suffix>.");
  }
  const url = new URL(base.url);
  url.pathname = `/${name}`;
  if (
    environment.DATABASE_URL &&
    sameDatabase(databaseTarget(url.href), databaseTarget(environment.DATABASE_URL))
  ) {
    throw new Error("Evaluations must not target the configured application database.");
  }
  const admin = new URL(url);
  admin.pathname = "/postgres";
  return { name, databaseUrl: url.href, adminUrl: admin.href };
}
