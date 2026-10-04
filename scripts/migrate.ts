import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { databaseConnectionString } from "../src/lib/auth/database";

loadEnvConfig(path.resolve("."));
const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error(
    "Set DATABASE_URL in .env.local before running migrations.",
  );
const pool = new Pool({ connectionString: databaseConnectionString(connectionString), connectionTimeoutMillis: 5000 });
async function main() {
  const db = await pool.connect();
  try {
    const existing = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'study_partner' ORDER BY table_name",
    );
    console.log(
      "Existing study_partner tables:",
      existing.rows.map((row) => row.table_name).join(", ") || "none",
    );
    if (process.argv.includes("--check")) return;
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(74320119)");
    await db.query("CREATE SCHEMA IF NOT EXISTS study_partner");
    await db.query("SET LOCAL search_path = study_partner, public");
    await db.query(
      "CREATE TABLE IF NOT EXISTS study_partner.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const names = (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names) {
      const sql = await readFile(path.join("migrations", name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await db.query(
        "SELECT checksum FROM study_partner.schema_migrations WHERE name = $1",
        [name],
      );
      if (applied.rows.length) {
        if (applied.rows[0].checksum !== checksum)
          throw new Error(`Previously applied migration changed: ${name}`);
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO study_partner.schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, checksum],
      );
      console.log(`Applied ${name}`);
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
main()
  .catch(() => {
    console.error(
      "Migration failed. Check database access, schema compatibility, and migration checksums. No changes from this run were committed.",
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
