/** Resolve database routing without accepting query parameters that disguise the actual target. */
export function databaseTarget(value: string): { url: URL; name: string; host: string; port: string } {
  let url: URL;
  try {
    url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Database configuration must be a PostgreSQL URL.");
  }
  const routingParameters = new Set(["host", "hostaddr", "port", "database", "dbname", "db", "service"]);
  if ([...url.searchParams.keys()].some((key) => routingParameters.has(key.toLowerCase()))) {
    throw new Error("Put database host, port and name in the URL, not routing query parameters.");
  }
  const host = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase())
    ? "loopback"
    : url.hostname.toLowerCase();
  return { url, name: decodeURIComponent(url.pathname.slice(1)), host, port: url.port || "5432" };
}

export function sameDatabase(a: ReturnType<typeof databaseTarget>, b: ReturnType<typeof databaseTarget>) {
  return a.name === b.name && a.host === b.host && a.port === b.port;
}
