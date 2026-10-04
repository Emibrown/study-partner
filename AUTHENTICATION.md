# Google-only authentication

## Configuration
Set these five server-only values in the ignored `.env.local` (or the existing `.env`) or server environment. Existing secret files are not modified by this change.

- `DATABASE_URL`: PostgreSQL connection. Remote hosts default to certificate-verified TLS when no explicit TLS parameters are supplied. Local loopback test databases can use plaintext. Explicit provider certificate settings are preserved.
- `BETTER_AUTH_SECRET`: stable cryptographically random secret of at least 32 characters.
- `BETTER_AUTH_URL`: exact application origin; local default `http://localhost:3000`, HTTPS in production.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: Google Web application OAuth credentials.

Resend and email sender configuration are no longer required or used. Existing values may remain in private environment files. Never publish credentials or prefix them with NEXT_PUBLIC_.

Google's registered local callback must be exactly `http://localhost:3000/api/auth/callback/google`. The production callback is the configured application origin followed by `/api/auth/callback/google`. Register matching origins and callbacks when changing ports or domains. Complete Google's consent-screen configuration and add test users while the OAuth app is in testing.

## Behavior and security
The only sign-in and registration method is Google with verified email. New Google accounts complete onboarding; returning accounts resume an allowlisted local return path. Google uses only openid, email, and profile scopes. Linking and unlinking providers are disabled.

Better Auth password authentication is disabled. A server hook allowlists only Google OAuth and session-management operations, rejecting password registration, login, recovery, password changes/setup, email verification/change, and provider linking. Old sign-up, verification, and recovery pages have been deleted and return 404.

Sessions are stored in PostgreSQL, expire after seven days, and renew daily. Cookies are HTTP-only, SameSite Lax, and Secure in production. Every study page verifies its session on the server; preferences APIs independently verify identity and enforce ownership, origin, and strict input validation. Sign-out revokes the current session. Temporary study state is keyed by account and cleared on full authentication navigation. Learning features remain simulated.

Database-backed rate limits include a stricter Google-start limit. Configure the trusted reverse proxy to replace untrusted forwarded-IP headers. Next incoming request logs are disabled; hosting, proxy, and APM logs must also redact cookies, OAuth codes/state, authorization headers, and request bodies.

## Migrations and intentional reset
Normal installation and updates use `npm run db:check` followed by `npm run db:migrate`. Versioned SQL is checksum-tracked and transactional; normal migrations do not reset data.

The Google-only transition reset only the `study_partner` schema after making and validating a private schema backup. The one-time reset script has been removed now that the transition is complete. No reset is part of normal startup, migration, or testing.

Backups under `.private-backups/` have private directory/file permissions and are excluded from Git, lint, and transcript artifacts. They contain personal/account data and must never be uploaded. Retain the validated backup until you have confirmed the new login works. Restore only after inspecting the archive and target database.

## Automated checks
```sh
npm run test:db
npm run test:auth
npm run test:e2e
npm run test:db:stop
npm run lint
npm run typecheck
npm run build
```

Tests use only the disposable loopback PostgreSQL instance on port 55439. Playwright runs on port 3100 with fake credentials and a separate build directory. A test-only Node preload intercepts Google's token response; browser tests intercept the Google authorization redirect. State, callback processing, sessions, onboarding, and preferences still go through the application's real handlers. There is no application auth bypass or test-login endpoint. External HTTPS requests are blocked in the mock transport.

Coverage includes Google success, cancellation, invalid state, unverified identity rejection, returning users, sign-out, renewal/expiry, rate limits, blocked password/email APIs, removed-page 404 responses, safe return paths, preferences isolation, study journeys, and responsive accessibility checks. Browser traces remain disabled; test data and screenshots remain local.

## Live acceptance
Mocked tests do not establish that live Google consent or callback settings are correct. Open the local app, click Continue with Google, choose your account, and complete consent yourself. Confirm onboarding, Settings identity, and sign-out/returning sign-in. Verify production HTTPS cookies and trusted-proxy behavior before deployment. No deployment or transcript publication is included.

References: [Better Auth Google](https://better-auth.com/docs/authentication/google), [Next.js integration](https://better-auth.com/docs/integrations/next).
