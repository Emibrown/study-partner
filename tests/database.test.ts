import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseConnectionString } from "../src/lib/auth/database";

test("remote PostgreSQL defaults to certificate-verified TLS without changing credentials", () => {
  const original = new URL("postgresql://user:p%40ss@db.example.test/app?application_name=study");
  const result = new URL(databaseConnectionString(original.toString()));
  assert.equal(result.searchParams.get("sslmode"), "verify-full");
  assert.equal(result.username, original.username);
  assert.equal(result.password, original.password);
  assert.equal(result.searchParams.get("application_name"), "study");
});
test("loopback test databases do not require TLS", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const result = new URL(databaseConnectionString(`postgresql://user@${host}:55439/test`));
    assert.equal(result.searchParams.has("sslmode"), false);
  }
});
test("explicit provider TLS configuration is preserved", () => {
  for (const query of ["sslmode=verify-full", "sslmode=require&sslrootcert=%2Fcert.pem", "ssl=true", "sslmode=disable"]) {
    const url = `postgresql://user@db.example.test/app?${query}`;
    assert.equal(databaseConnectionString(url), new URL(url).toString());
  }
});
