import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";
import type { AuthConfig } from "./config";

const allowedPaths = new Set([
  "/sign-in/social",
  "/callback/:id",
  "/get-session",
  "/sign-out",
  "/list-accounts",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);
export function createAuth(
  config: AuthConfig,
  database: Pool,
  deferSessionRefresh = false,
) {
  return betterAuth({
    appName: "Study Partner",
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [config.BETTER_AUTH_URL],
    logger: { disabled: true },
    onAPIError: { errorURL: `${config.BETTER_AUTH_URL}/sign-in` },
    emailAndPassword: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Only Google identity and session-management operations are exposed.
        if (!allowedPaths.has(ctx.path)) throw new APIError("NOT_FOUND");
        if (ctx.path === "/callback/:id" && ctx.params?.id !== "google")
          throw new APIError("NOT_FOUND");
      }),
    },
    socialProviders: {
      google: {
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
        requireEmailVerification: true,
        includeGrantedScopes: false,
      },
    },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
    },
    session: {
      deferSessionRefresh,
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: { "/sign-in/social": { window: 60, max: 10 } },
    },
    advanced: {
      useSecureCookies:
        process.env.NODE_ENV === "production" ||
        config.BETTER_AUTH_URL.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
  });
}
