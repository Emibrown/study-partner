import { test, expect, origin, createUser } from "./auth-fixture";
import AxeBuilder from "@axe-core/playwright";
const notes =
  "The fictional solar cart stores energy in a battery. A panel collects sunlight. A motor turns the wheels. A switch controls the motor. A fuse protects the circuit.";
test("consented study, modes, practice resume, history and reset", async ({
  page,
  browser,
}, testInfo) => {
  const response = await page.request.post("/api/materials", {
    headers: { origin },
    data: { title: "Fictional solar cart", notes },
  });
  expect(response.ok()).toBe(true);
  const material = await response.json();
  await page.goto(`/study/${material.id}`);
  await page.getByRole("button", { name: "Enable AI study" }).click();
  await expect(page.getByRole("dialog")).toContainText("Backboard");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Enable AI study" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Enable AI study" }).click();
  await page.getByRole("button", { name: "Agree and prepare" }).click();
  await page
    .getByLabel("Your message", { exact: true })
    .fill("Explain the cart");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".ai-message.assistant")).toContainText("battery");
  await page.getByRole("button", { name: "Quiz", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Quiz", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ai-message.assistant")).toHaveCount(1);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.locator(".ai-message.assistant")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Explain It Back", exact: true })
    .click();
  await page
    .getByLabel("Your message", { exact: true })
    .fill("Slow fixture response");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop generation", exact: true })
    .click();
  await expect(page.getByLabel("Your message", { exact: true })).toBeEnabled();
  await page
    .getByLabel("Your message", { exact: true })
    .fill("Explain the cart");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".ai-message.assistant")).toContainText("battery");
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
      path: testInfo.outputPath(`conversation-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("link", { name: "Practice this material" }).click();
  await page.getByRole("button", { name: "Generate practice" }).click();
  await expect(
    page.getByRole("group", {
      name: "Where does the solar cart store energy?",
    }),
  ).toBeVisible();
  await page.getByLabel("Panel", { exact: true }).check();
  await page.getByRole("button", { name: "Check answer" }).click();
  await expect(page.getByRole("heading", { name: "Not quite" })).toBeVisible();
  await page.reload();
  for (const choice of ["Sunlight", "Motor", "Switch", "Fuse"]) {
    await page.getByLabel(choice, { exact: true }).check();
    await page.getByRole("button", { name: "Check answer" }).click();
    await page
      .getByRole("button", { name: /Next question|View recap/ })
      .click();
  }
  await expect(page.getByText("4 / 5 correct", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("practice-recap-mobile.png"),
    fullPage: true,
  });
  await page.goto("/history");
  await expect(page.getByText("Practice: 4 / 5 correct")).toBeVisible();
  const other = await browser.newContext({ baseURL: origin });
  await createUser(other.request);
  expect(
    (await other.request.get(`/api/materials/${material.id}/ai`)).status(),
  ).toBe(404);
  await other.close();
  await page.goto(`/study/${material.id}`);
  await page
    .getByRole("button", { name: "Reset AI data", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset AI study data", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Enable AI study" }),
  ).toBeVisible();
  await page.goto("/history");
  await expect(
    page.getByRole("heading", { name: "No study sessions yet" }),
  ).toBeVisible();
});
