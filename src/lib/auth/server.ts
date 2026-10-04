import "server-only";
import { Pool } from "pg";
import { readAuthConfig } from "./config";
import { createAuth } from "./factory";
import { databaseConnectionString } from "./database";

let services:
  | {
      auth: ReturnType<typeof createAuth>;
      readOnlyAuth: ReturnType<typeof createAuth>;
      pool: Pool;
    }
  | undefined;
export function getAuthServices() {
  if (services) return services;
  const config = readAuthConfig();
  if (!config) throw new Error("Authentication configuration is incomplete.");
  const pool = new Pool({
    connectionString: databaseConnectionString(config.DATABASE_URL),
    options: "-c search_path=study_partner,public",
    max: 10,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", () =>
    console.error("Authentication database connection failed."),
  );
  services = {
    auth: createAuth(config, pool),
    readOnlyAuth: createAuth(config, pool, true),
    pool,
  };
  return services;
}
