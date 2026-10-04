import { test, expect, origin } from "./auth-fixture";
import AxeBuilder from "@axe-core/playwright";
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});
async function prepare(page: import("@playwright/test").Page) {
  const response = await page.request.post("/api/materials", {
    headers: { origin },
    data: {
      title: "Fictional solar cart",
      notes:
        "A solar panel collects sunlight. A battery stores energy. A motor turns the wheels.",
    },
  });
  const material = await response.json();
  expect(
    (
      await page.request.post(`/api/materials/${material.id}/ai`, {
        headers: { origin },
        data: { consent: true },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/voice?material=${material.id}`);
  return material;
}
test("voice consent, synthetic microphone, controls, saved transcript and responsive accessibility", async ({
  page,
}, info) => {
  await prepare(page);
  const start = page.getByRole("button", {
    name: "Start voice session",
    exact: true,
  });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("dialog")).toContainText("microphone");
  await page.keyboard.press("Escape");
  await expect(start).toBeFocused();
  await page
    .getByRole("button", { name: "Mock Examiner", exact: true })
    .click();
  await start.click();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Time remaining")).toBeVisible();
  await page
    .getByRole("button", { name: "Mute microphone", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Unmute microphone", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Mute speaker", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unmute speaker", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Hide transcript", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Voice transcript" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show transcript", exact: true })
    .click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const controls = await page.locator(".voice-call-main").boundingBox();
    const transcript = await page
      .getByRole("region", { name: "Voice transcript" })
      .boundingBox();
    expect(controls).not.toBeNull();
    expect(transcript).not.toBeNull();
    if (width >= 1024) {
      expect(transcript!.x).toBeGreaterThanOrEqual(
        controls!.x + controls!.width,
      );
      expect(Math.abs(transcript!.y - controls!.y)).toBeLessThan(2);
    } else {
      expect(transcript!.y).toBeGreaterThanOrEqual(
        controls!.y + controls!.height,
      );
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: info.outputPath(`voice-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Saved transcript", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Saved transcript", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toHaveCount(0);
  await page.goto("/history");
  await expect(
    page.getByText("Mock Examiner: ended", { exact: true }),
  ).toBeVisible();
});

test("navigation releases microphone tracks and records interruption", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const media = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const tracks: MediaStreamTrack[] = [];
    Object.assign(window, { voiceFixtureTracks: tracks });
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await media(constraints);
      tracks.push(...stream.getTracks());
      return stream;
    };
  });
  await prepare(page);
  await page
    .getByRole("button", { name: "Start voice session", exact: true })
    .click();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".voice-stage [role=status]")).toContainText(
    "Listening",
  );
  await page.getByRole("link", { name: "Study history", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { voiceFixtureTracks: MediaStreamTrack[] }
        ).voiceFixtureTracks.every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  const list = await (await page.request.get("/api/voice-sessions")).json();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/voice-sessions/${list.sessions[0].id}`)
          ).json()
        ).interrupted,
    )
    .toBe(true);
});

test("navigation during token creation revokes the late result", async ({
  page,
}) => {
  await prepare(page);
  let release!: () => void, captured!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let sessionId = "";
  await page.route("**/api/voice-sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    sessionId = (await response.json()).session.id;
    captured();
    await hold;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Start voice session", exact: true })
    .click();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await received;
  await page.getByRole("link", { name: "Study history", exact: true }).click();
  release();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/voice-sessions/${sessionId}`)
          ).json()
        ).interrupted,
    )
    .toBe(true);
});

test("connection failures end the transport without automatic microphone restart", async ({
  page,
}) => {
  await prepare(page);
  await page
    .getByRole("button", { name: "Start voice session", exact: true })
    .click();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("voice-fixture-error")),
  );
  await expect(page.locator(".voice-call [role=alert]")).toContainText(
    "The voice transport disconnected",
  );
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Mute microphone", exact: true }),
  ).toHaveCount(0);
});
test("microphone denial does not reserve a billable call", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await prepare(page);
  await page
    .getByRole("button", { name: "Start voice session", exact: true })
    .click();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await expect(page.locator(".voice-call [role=alert]")).toContainText(
    "Microphone permission was denied",
  );
  expect(
    (await (await page.request.get("/api/voice-sessions")).json()).sessions,
  ).toEqual([]);
});

test("the displayed deadline ends the call without a manual click", async ({
  page,
}) => {
  await prepare(page);
  await page.route("**/api/voice-sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data.session.expiresAt = new Date(Date.now() + 3000).toISOString();
    await route.fulfill({ response, json: data });
  });
  // Keep the shortened fixture deadline when the real binding endpoint responds.
  await page.route("**/api/voice-sessions/*/bind", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.expiresAt = new Date(Date.now() + 3000).toISOString();
    await route.fulfill({ response, json: data });
  });
  await page
    .getByRole("button", { name: "Start voice session", exact: true })
    .click();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await expect(
    page.getByRole("button", { name: "End session", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "End session", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Saved transcript", exact: true }),
  ).toBeVisible();
});
