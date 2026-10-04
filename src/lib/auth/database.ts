export function databaseConnectionString(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const explicitTLS = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"].some(
    (key) => url.searchParams.has(key),
  );
  // Hosted databases default to verified TLS; preserve explicit provider settings.
  if (!local && !explicitTLS) url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}
