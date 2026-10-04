import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { defaultPreferences } from "../src/lib/fixtures";
export const origin = "http://localhost:3100";
export function mockCode(email: string, verified = true) {
  return (
    "mock." +
    Buffer.from(JSON.stringify({ email, verified })).toString("base64url")
  );
}
export async function clearLimits() {
  const pool = new Pool({
    connectionString:
      "postgresql://study_test@127.0.0.1:55439/study_partner_test",
  });
  try {
    await pool.query('DELETE FROM study_partner."rateLimit"');
  } finally {
    await pool.end();
  }
}
export async function createUser(
  request: APIRequestContext,
  onboarded = true,
  email = `${randomUUID()}@example.test`,
) {
  const started = await request.post("/api/auth/sign-in/social", {
    headers: { origin },
    data: {
      provider: "google",
      callbackURL: "/auth/continue",
      errorCallbackURL: "/sign-in",
    },
  });
  expect(started.status()).toBe(200);
  const state = new URL((await started.json()).url).searchParams.get("state")!;
  const result = await request.get(
    `/api/auth/callback/google?state=${encodeURIComponent(state)}&code=${mockCode(email)}`,
    { maxRedirects: 0 },
  );
  expect(result.status()).toBe(302);
  expect(
    (await (await request.get("/api/auth/get-session")).json()).user.email,
  ).toBe(email);
  if (onboarded)
    expect(
      (
        await request.post("/api/me/onboarding", {
          headers: { origin },
          data: defaultPreferences,
        })
      ).status(),
    ).toBe(200);
  return email;
}
export async function mockGoogleBrowser(
  page: Page,
  email: string,
  cancel = false,
) {
  await page.route("https://accounts.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("redirect_uri")).toBe(
      origin + "/api/auth/callback/google",
    );
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    const callback = new URL(origin + "/api/auth/callback/google");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    if (cancel) callback.searchParams.set("error", "access_denied");
    else callback.searchParams.set("code", mockCode(email));
    await route.fulfill({
      status: 302,
      headers: { location: callback.toString() },
    });
  });
}
export const test = base.extend({
  page: async ({ page }, runTest) => {
    await clearLimits();
    await createUser(page.request);
    await runTest(page);
  },
});
export { expect };
