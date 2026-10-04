import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
const directory = path.resolve(".auth-test/postgres");
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed. Install PostgreSQL tools and add them to PATH.`,
    );
}
if (process.argv.includes("--stop")) run("pg_ctl", ["-D", directory, "stop"]);
else {
  mkdirSync(path.dirname(directory), { recursive: true });
  if (!existsSync(path.join(directory, "PG_VERSION")))
    run("initdb", [
      "-D",
      directory,
      "--auth=trust",
      "--username=study_test",
      "--no-locale",
      "--encoding=UTF8",
    ]);
  const running =
    spawnSync("pg_ctl", ["-D", directory, "status"], { stdio: "ignore" })
      .status === 0;
  if (!running)
    run("pg_ctl", [
      "-D",
      directory,
      "-l",
      path.resolve(".auth-test/postgres.log"),
      "-o",
      "-h 127.0.0.1 -p 55439",
      "start",
    ]);
  const exists = spawnSync(
    "psql",
    [
      "-h",
      "127.0.0.1",
      "-p",
      "55439",
      "-U",
      "study_test",
      "-d",
      "postgres",
      "-tAc",
      "SELECT 1 FROM pg_database WHERE datname = 'study_partner_test'",
    ],
    { encoding: "utf8" },
  );
  if (exists.status !== 0)
    throw new Error("Could not inspect the isolated database.");
  if (exists.stdout.trim() !== "1")
    run("createdb", [
      "-h",
      "127.0.0.1",
      "-p",
      "55439",
      "-U",
      "study_test",
      "study_partner_test",
    ]);
  const migration = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/migrate.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL:
          "postgresql://study_test@127.0.0.1:55439/study_partner_test",
      },
    },
  );
  if (migration.status !== 0) process.exitCode = 1;
}
