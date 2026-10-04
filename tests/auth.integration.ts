import "./mock-google.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createAuth } from "../src/lib/auth/factory";
import { safeReturnPath } from "../src/lib/auth/return-path";
import {
  readProfile,
  saveProfile,
  preferencesSchema,
} from "../src/lib/auth/preferences";
import { defaultPreferences } from "../src/lib/fixtures";

const database = new Pool({
  connectionString:
    "postgresql://study_test@127.0.0.1:55439/study_partner_test",
  options: "-c search_path=study_partner,public",
});
const origin = "http://localhost:3100";
const auth = createAuth(
  {
    DATABASE_URL: "unused",
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "isolated-auth-test-secret-not-for-deployment-12345",
    GOOGLE_CLIENT_ID: "test",
    GOOGLE_CLIENT_SECRET: "test",
  },
  database,
);
let ip = 1;
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
async function request(
  path: string,
  body?: unknown,
  cookies = "",
  address = `10.80.${Math.floor(ip / 250)}.${ip++ % 250}`,
  extra = {},
) {
  return auth.handler(
    new Request(origin + "/api/auth" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "x-forwarded-for": address,
        cookie: cookies,
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function start() {
  const response = await request("/sign-in/social", {
    provider: "google",
    callbackURL: "/auth/continue",
    errorCallbackURL: "/sign-in",
  });
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  assert.deepEqual(url.searchParams.get("scope")!.split(" ").sort(), [
    "email",
    "openid",
    "profile",
  ]);
  assert.ok(url.searchParams.get("code_challenge"));
  return { state: url.searchParams.get("state")!, cookies: cookie(response) };
}
async function login(email = `${randomUUID()}@example.test`, verified = true) {
  const flow = await start();
  const code =
    "mock." +
    Buffer.from(JSON.stringify({ email, verified })).toString("base64url");
  return request(
    `/callback/google?state=${encodeURIComponent(flow.state)}&code=${code}`,
    undefined,
    flow.cookies,
  );
}
after(async () => {
  await database.end();
});
test("Google creates verified accounts, returning sign-in reuses identity and sign-out revokes session", async () => {
  const email = `${randomUUID()}@example.test`;
  const response = await login(email);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/i);
  const cookies = cookie(response);
  const session = await (
    await request("/get-session", undefined, cookies)
  ).json();
  assert.equal(session.user.email, email);
  assert.equal(session.user.emailVerified, true);
  const returning = await (
    await request("/get-session", undefined, cookie(await login(email)))
  ).json();
  assert.equal(returning.user.id, session.user.id);
  assert.equal((await readProfile(database, session.user.id)).onboarded, false);
  assert.equal((await request("/sign-out", {}, cookies)).status, 200);
  assert.equal(
    await (await request("/get-session", undefined, cookies)).json(),
    null,
  );
});
test("password, verification, linking and recovery operations are unavailable even when signed in", async () => {
  const before = await database.query(
    'SELECT count(*)::int as count FROM account WHERE "providerId"=$1',
    ["credential"],
  );
  const cookies = cookie(await login());
  const body = {
    email: "old@example.test",
    password: "An obsolete password",
    name: "Old Account",
    newPassword: "Another obsolete password",
    currentPassword: "An obsolete password",
    token: "old-token",
    provider: "google",
    accountId: "old",
  };
  for (const path of [
    "/sign-in/email",
    "/sign-up/email",
    "/request-password-reset",
    "/reset-password",
    "/change-password",
    "/set-password",
    "/send-verification-email",
    "/link-social",
    "/unlink-account",
    "/change-email",
  ]) {
    for (const session of ["", cookies]) {
      const result = await request(path, body, session);
      assert.ok(
        [400, 404].includes(result.status),
        path + ": " + result.status,
      );
    }
  }
  for (const path of [
    "/verify-email?token=old",
    "/reset-password/old?callbackURL=/reset-password",
  ]) {
    const response = await request(path, undefined, cookies);
    assert.equal(response.status, 404);
  }
  assert.equal(
    (
      await database.query(
        'SELECT count(*)::int as count FROM account WHERE "providerId"=$1',
        ["credential"],
      )
    ).rows[0].count,
    before.rows[0].count,
  );
});
test("Google cancellation, invalid state and unverified identity never create sessions", async () => {
  const flow = await start();
  const cancelled = await request(
    `/callback/google?state=${flow.state}&error=access_denied`,
    undefined,
    flow.cookies,
  );
  assert.match(
    cancelled.headers.get("location")!,
    /sign-in.*error=access_denied/,
  );
  const invalid = await request("/callback/google?state=invalid&code=invalid");
  assert.match(invalid.headers.get("location")!, /sign-in/);
  assert.ok(!cookie(invalid).includes("session_token"));
  const unverified = await login(undefined, false);
  assert.ok(!cookie(unverified).includes("session_token"));
});
test("session expiry, daily renewal, preferences isolation, local return paths and CSRF", async () => {
  const cookies = cookie(await login());
  const session = await (
    await request("/get-session", undefined, cookies)
  ).json();
  await saveProfile(
    database,
    session.user.id,
    { ...defaultPreferences, duration: "30 minutes" },
    true,
  );
  assert.equal((await readProfile(database, session.user.id)).onboarded, true);
  assert.equal(
    (await readProfile(database, "nonexistent-user")).preferences.duration,
    "20 minutes",
  );
  assert.equal(
    preferencesSchema.safeParse({ ...defaultPreferences, userId: "another" })
      .success,
    false,
  );
  await database.query(
    'UPDATE session SET "expiresAt" = now() + interval \'5 days\', "updatedAt" = now() - interval \'2 days\' WHERE "userId" = $1',
    [session.user.id],
  );
  const renewed = await (
    await request("/get-session", undefined, cookies)
  ).json();
  assert.ok(
    new Date(renewed.session.expiresAt).getTime() > Date.now() + 6 * 86400000,
  );
  await database.query(
    'UPDATE session SET "expiresAt" = now() - interval \'1 hour\' WHERE "userId" = $1',
    [session.user.id],
  );
  assert.equal(
    await (await request("/get-session", undefined, cookies)).json(),
    null,
  );
  assert.equal(
    (
      await request("/sign-in/social", { provider: "google" }, "", undefined, {
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  for (const path of [
    "//evil.example",
    "https://evil.example",
    "/sign-in",
    "/api/auth/sign-out",
    "/%2f%2fevil",
  ])
    assert.equal(safeReturnPath(path), "/");
});
test("Google sign-in has database-backed rate limits", async () => {
  const address = `10.99.2.${Math.ceil(Math.random() * 200)}`;
  let response: Response;
  for (let i = 0; i < 11; i++)
    response = await request(
      "/sign-in/social",
      { provider: "google", callbackURL: "/" },
      "",
      address,
    );
  assert.equal(response!.status, 429);
});
