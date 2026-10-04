import { test, expect, origin, createUser } from "./auth-fixture";
import AxeBuilder from "@axe-core/playwright";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { makePdf } from "./pdf-fixture";

test("private PDF preview renders nonblank on desktop and mobile with mocked content", async ({
  page,
}, testInfo) => {
  const session = await (
    await page.request.get("/api/auth/get-session")
  ).json();
  const pool = new Pool({
    connectionString:
      "postgresql://study_test@127.0.0.1:55439/study_partner_test",
  });
  const id = randomUUID();
  const pdf = makePdf();
  try {
    await pool.query(
      "INSERT INTO study_partner.materials (id,user_id,title,kind,object_key,byte_size,state) VALUES ($1,$2,'My PDF notes','PDF',$3,$4,'ready')",
      [id, session.user.id, `test/${id}`, pdf.byteLength],
    );
    await page.route(`**/api/materials/${id}/content`, (route) =>
      route.fulfill({ status: 200, contentType: "application/pdf", body: pdf }),
    );
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/study/${id}`);
      if (width < 761) await page.getByRole("tab", { name: "Material", exact: true }).click();
      await expect(
        page.getByText("Page 1 of 1", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () =>
          page
            .getByRole("region", { name: "PDF preview", exact: true })
            .locator("canvas")
            .evaluate((canvas: HTMLCanvasElement) => {
              const context = canvas.getContext("2d")!;
              const pixel = context.getImageData(100, 180, 1, 1).data;
              return pixel[1] > pixel[0] && pixel[3] > 0;
            }),
        )
        .toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`pdf-${width}.png`),
        fullPage: true,
      });
    }
  } finally {
    await pool.query("DELETE FROM study_partner.materials WHERE id=$1", [id]);
    await pool.end();
  }
});

async function addNotes(
  page: import("@playwright/test").Page,
  title = "My own lecture notes",
  notes = "A personal outline for revision.\nSecond paragraph.",
) {
  await page.getByRole("button", { name: "Add material", exact: true }).click();
  await page.getByRole("tab", { name: "Paste notes" }).click();
  await page.getByLabel("Material title").fill(title);
  await page.getByLabel("Your notes", { exact: true }).fill(notes);
  await page
    .getByRole("button", { name: "Save material", exact: true })
    .click();
  await expect(page).toHaveURL(/\/study\/[a-f0-9-]+$/);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

test("empty workspace, persisted notes, filters and deletion", async ({
  page,
}) => {
  await page.goto("/library");
  await expect(
    page.getByRole("heading", { name: "Your library starts here" }),
  ).toBeVisible();
  await addNotes(page);
  await expect(
    page.getByText("Second paragraph.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable AI study", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".notes-content")).toContainText(
    "A personal outline",
  );
  await page.getByRole("link", { name: "Back to library" }).click();
  await page.getByLabel("Search materials").fill("no matches");
  await expect(
    page.getByRole("heading", { name: "No matching materials" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Search materials")).toHaveValue("no matches");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("tab", { name: "PDF", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "PDF", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  await page.getByRole("link", { name: /My own lecture notes/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".notes-content")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete material", exact: true })
    .click();
  await expect(page).toHaveURL(origin + "/library");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your library starts here" }),
  ).toBeVisible();
});

test("dialog labels, errors, escape, retry and missing R2 configuration", async ({
  page,
}) => {
  await page.goto("/library");
  await page.getByRole("button", { name: "Add material", exact: true }).click();
  await expect(
    page.getByText(
      "PDF uploads are not configured yet. You can paste notes instead.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Choose your study notes")).toBeDisabled();
  await page.getByRole("tab", { name: "Paste notes" }).click();
  await page
    .getByRole("button", { name: "Save material", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Add a title");
  await page.getByLabel("Material title").fill("Saved after retry");
  await page.getByLabel("Your notes", { exact: true }).fill("Private text");
  await page.route("**/api/materials", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            message: "Storage unavailable. Please try again.",
          }),
        })
      : route.continue(),
  );
  await page
    .getByRole("button", { name: "Save material", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Storage unavailable");
  await expect(page.getByLabel("Your notes", { exact: true })).toHaveValue(
    "Private text",
  );
  await page.unroute("**/api/materials");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add material", exact: true }),
  ).toBeFocused();
});

test("materials are isolated, escaped, downloadable and not replaceable by sample content", async ({
  page,
  browser,
}) => {
  await page.goto("/library");
  await addNotes(
    page,
    "Personal reading",
    "<script>window.compromised=true</script>\nA & B",
  );
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.locator(".notes-content")).toContainText("<script>");
  expect(await page.evaluate(() => "compromised" in window)).toBe(false);
  const content = await page.request.get(`/api/materials/${id}/content`);
  expect(await content.text()).toContain("A & B");
  const other = await browser.newContext({ baseURL: origin });
  await createUser(other.request);
  for (const suffix of ["", "/content"])
    expect(
      (await other.request.get(`/api/materials/${id}${suffix}`)).status(),
    ).toBe(404);
  expect(
    (
      await other.request.delete(`/api/materials/${id}`, {
        headers: { origin },
      })
    ).status(),
  ).toBe(404);
  const second = await other.newPage();
  await second.goto(`/study/${id}`);
  await expect(second.locator(".notes-content")).toHaveCount(0);
  await other.close();
  await page.goto("/study/cell-biology");
  await expect(page.locator(".notes-content")).toHaveCount(0);
  await page.goto("/history");
  await expect(
    page.getByRole("heading", { name: "No study sessions yet" }),
  ).toBeVisible();
  await page.goto("/practice");
  await expect(page.getByLabel("Material", { exact: true })).toBeVisible();
  for (const path of ["/voice"]) {
    await page.goto(path);
    await expect(
      page.getByLabel("Material", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/chloroplast|ribosome|cell membrane/i),
    ).toHaveCount(0);
  }
});

test("preferences remain saved without a subject selector", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByLabel("Subject", { exact: true })).toHaveCount(0);
  await page.getByLabel("Session length").selectOption("30 minutes");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(
    page.getByText("Preferences saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Session length")).toHaveValue("30 minutes");
});

for (const width of [1440, 390, 320])
  test(`responsive material flow and accessibility at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/library");
    await addNotes(
      page,
      "A long material title that should wrap naturally without pushing any controls out of the viewport",
      "LongWord".repeat(50) + "\n" + "More notes for scrolling.\n".repeat(40),
    );
    for (const route of [
      page.url(),
      "/library",
      "/",
      "/history",
      "/practice",
      "/voice",
      "/onboarding",
    ]) {
      await page.goto(route);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(
          `${new URL(page.url()).pathname.replaceAll("/", "_")}-${width}.png`,
        ),
        fullPage: true,
      });
    }
  });
