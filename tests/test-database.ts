import { databaseTarget, sameDatabase } from "../scripts/database-target";

/** A supplied test database is modified by the suite; require an explicit disposable target. */
export function checkTestDatabase(environment: NodeJS.ProcessEnv): void {
  const value = environment.TEST_DATABASE_URL;
  if (!value) return;
  const target = databaseTarget(value);
  if (!/^val_test(?:_[a-z0-9_]+)?$/i.test(target.name))
    throw new Error(
      "TEST_DATABASE_URL must name val_test or val_test_<suffix>, in a disposable database cluster.",
    );
  if (environment.DATABASE_URL) {
    const saved = databaseTarget(environment.DATABASE_URL);
    if (sameDatabase(saved, target)) {
      throw new Error("TEST_DATABASE_URL must not target the configured application database.");
    }
  }
  if (environment.VAL_TEST_DATABASE_DISPOSABLE !== "true")
    throw new Error(
      "Set VAL_TEST_DATABASE_DISPOSABLE=true only after confirming the supplied test database and cluster are disposable.",
    );
}
