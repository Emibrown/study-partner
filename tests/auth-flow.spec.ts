import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  clearLimits,
  createUser,
  mockGoogleBrowser,
  origin,
} from "./auth-fixture";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { defaultPreferences } from "../src/lib/fixtures";

test.beforeEach(async () => {
  await clearLimits();
});
test("proxy rejects expired and revoked sessions without renewing or deleting them", async ({
  page,
}) => {
  const email = await createUser(page.request);
  const pool = new Pool({
    connectionString:
      "postgresql://study_test@127.0.0.1:55439/study_partner_test",
  });
  try {
    const session = (
      await (await page.request.get("/api/auth/get-session")).json()
    ).session;
    await pool.query(
      "UPDATE study_partner.session SET \"updatedAt\" = NOW() - INTERVAL '2 days' WHERE id = $1",
      [session.id],
    );
    const before = (
      await pool.query(
        'SELECT "updatedAt" FROM study_partner.session WHERE id = $1',
        [session.id],
      )
    ).rows[0];
    expect(
      (
        await page.request.get("/library", {
          maxRedirects: 0,
          headers: { "next-router-prefetch": "1" },
        })
      ).status(),
    ).toBe(200);
    // Page rendering can renew sessions; use an incomplete user's redirect to isolate Proxy.
    await pool.query(
      'UPDATE study_partner.user_preferences SET onboarding_completed_at = NULL WHERE user_id = (SELECT id FROM study_partner."user" WHERE email = $1)',
      [email],
    );
    await pool.query(
      'UPDATE study_partner.session SET "updatedAt" = $1 WHERE id = $2',
      [before.updatedAt, session.id],
    );
    expect(
      (await page.request.get("/library", { maxRedirects: 0 })).status(),
    ).toBe(307);
    expect(
      (
        await pool.query(
          'SELECT "updatedAt" FROM study_partner.session WHERE id = $1',
          [session.id],
        )
      ).rows[0],
    ).toEqual(before);
    await pool.query(
      "UPDATE study_partner.session SET \"expiresAt\" = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [session.id],
    );
    const expired = await page.request.get("/library", { maxRedirects: 0 });
    expect(new URL(expired.headers().location, origin).pathname).toBe(
      "/sign-in",
    );
    expect(
      (
        await pool.query("SELECT id FROM study_partner.session WHERE id = $1", [
          session.id,
        ])
      ).rowCount,
    ).toBe(1);
    await pool.query("DELETE FROM study_partner.session WHERE id = $1", [
      session.id,
    ]);
    const revoked = await page.request.get("/library", { maxRedirects: 0 });
    expect(new URL(revoked.headers().location, origin).pathname).toBe(
      "/sign-in",
    );
  } finally {
    await pool.end();
  }
});
test("incomplete users redirect before rendering and can return after completion", async ({
  page,
}, testInfo) => {
  await createUser(page.request, false);
  for (const path of [
    "/",
    "/library",
    "/practice",
    "/voice",
    "/history",
    "/settings",
    "/study/cell-biology",
    "/recap/cell-review",
  ]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    const location = new URL(response.headers().location, origin);
    expect(location.pathname).toBe("/onboarding");
    expect(location.searchParams.get("next")).toBe(path);
    expect(await response.text()).not.toContain("My workspace");
  }
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Back to study space" }).click();
  await expect(page).toHaveURL(/\/onboarding\?next=%2F$/);
  await page.goto("/library");
  await expect(page).toHaveURL(/\/onboarding\?next=%2Flibrary$/);
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Back to study space" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Study Partner home" }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.goto("/library");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`onboarding-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Continue", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "2",
  );
  await page.getByRole("button", { name: "Make it my space" }).click();
  await expect(page).toHaveURL(origin + "/library");
  await page.goto("/onboarding");
  await expect(
    page.getByRole("link", { name: "Back to study space" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to study space" }).click();
  await expect(page).toHaveURL(origin + "/");
  expect(
    (
      await page.request.post("/api/auth/sign-out", {
        headers: { origin },
        data: {},
      })
    ).status(),
  ).toBe(200);
  const denied = await page.request.get("/library", { maxRedirects: 0 });
  expect(denied.status()).toBe(307);
  expect(new URL(denied.headers().location, origin).pathname).toBe("/sign-in");
  const unsafe = await page.request.get(
    "/onboarding?next=https://evil.example",
    { maxRedirects: 0 },
  );
  expect(
    new URL(unsafe.headers().location, origin).searchParams.get("next"),
  ).toBe("/");
});
test("Google cancellation and service errors are accessible", async ({
  page,
}) => {
  await mockGoogleBrowser(page, "cancel@example.test", true);
  await page.goto("/sign-in?next=/library");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.locator(".form-error")).toContainText("cancelled");
  await expect(page.locator(".form-error")).toBeFocused();
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "AUTH_UNAVAILABLE" }),
    }),
  );
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.locator(".form-error")).toContainText(
    "couldn't be completed",
  );
  await expect(page.locator(".form-error")).toBeFocused();
});
test("protected pages and preference endpoints reject unauthenticated users", async ({
  page,
  request,
}) => {
  for (const route of [
    "/",
    "/library",
    "/study/cell-biology",
    "/practice",
    "/voice",
    "/history",
    "/recap/cell-review",
    "/settings",
    "/onboarding",
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
  }
  expect((await request.get("/api/me/preferences")).status()).toBe(401);
  for (const endpoint of ["preferences", "onboarding"])
    expect(
      (
        await request.fetch("/api/me/" + endpoint, {
          method: endpoint === "preferences" ? "PUT" : "POST",
          headers: { origin },
          data: defaultPreferences,
        })
      ).status(),
    ).toBe(401);
});
test("Google registration, onboarding, returning login, preferences and account isolation", async ({
  page,
  browser,
}) => {
  const email = `${randomUUID()}@example.test`;
  await mockGoogleBrowser(page, email);
  await page.goto("/sign-in?next=/settings");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "2",
  );
  await page.getByRole("button", { name: "Make it my space" }).click();
  await expect(page).toHaveURL(/\/library$/);
  await page.goto("/settings");
  await expect(
    page.getByText("Signed in with Google", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Google" }),
  ).toHaveCount(0);
  await page.getByLabel("Session length").selectOption("30 minutes");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(
    page.getByText("Preferences saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Session length")).toHaveValue("30 minutes");
  expect(
    (
      await page.request.put("/api/me/preferences", {
        headers: { origin: "https://evil.example" },
        data: defaultPreferences,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.put("/api/me/preferences", {
        headers: { origin },
        data: { ...defaultPreferences, userId: "other" },
      })
    ).status(),
  ).toBe(400);
  const other = await browser.newContext({ baseURL: origin });
  await createUser(other.request);
  const otherPage = await other.newPage();
  await otherPage.goto("/settings");
  await expect(otherPage.getByLabel("Session length")).toHaveValue(
    "20 minutes",
  );
  await other.close();
  await page.getByRole("button", { name: "Open profile menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect((await page.request.get("/api/me/preferences")).status()).toBe(401);
  await page.goto("/sign-in?next=/settings");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByLabel("Session length")).toHaveValue("30 minutes");
});
test("removed auth pages return 404, safe return paths and responsive Google sign-in", async ({
  page,
}, testInfo) => {
  await createUser(page.request);
  await page.goto("/auth/continue?next=https://evil.example");
  await expect(page).toHaveURL(origin + "/");
  await page.goto("about:blank");
  await page.context().clearCookies();
  for (const route of [
    "sign-up",
    "forgot-password",
    "verify-email",
    "reset-password",
  ]) {
    const response = await page.goto(`/${route}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("textbox")).toHaveCount(0);
  }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/sign-in");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`google-sign-in-${width}.png`),
      fullPage: true,
    });
  }
});
