// Test-only transport loaded by the isolated server. Never imported by the app.
const originalFetch = globalThis.fetch;
import { mockBackboard } from "./mock-backboard.mjs";
import { browserEleven } from "./mock-elevenlabs.mjs";
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.elevenlabs.io/v1/")) return browserEleven.transport(input, init);
  if (url.startsWith("https://app.backboard.io/api/")) return mockBackboard(input, init);
  if (url === "https://oauth2.googleapis.com/token") {
    const form = new URLSearchParams(String(init?.body));
    const code = form.get("code") || "";
    if (!code.startsWith("mock."))
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    const profile = JSON.parse(
      Buffer.from(code.slice(5), "base64url").toString(),
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: profile.email,
        email: profile.email,
        name: "Fictional Student",
        email_verified: profile.verified !== false,
        aud: "test",
        iss: "https://accounts.google.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    return Response.json({
      access_token: "mock-access",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: `e30.${payload}.mock`,
    });
  }
  if (url.startsWith("https://"))
    throw new Error("External services are disabled in isolated tests");
  return originalFetch(input, init);
};
