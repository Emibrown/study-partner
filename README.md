# Study Partner

A private study-material library with Google-only authentication, PostgreSQL-backed notes and preferences, and private Cloudflare R2 PDF storage. Built with Next.js, TypeScript, Tailwind CSS, Radix UI, and Lucide.

## Run

```sh
npm install
npm run db:check
npm run db:migrate
npm run dev
```

Run commands from the project root. Configure root `.env` or `.env.local` using the placeholders in `.env.example`. Authentication setup is documented in [AUTHENTICATION.md](AUTHENTICATION.md). The default origin is http://localhost:3000; changes to the port must also update Better Auth and Google's callback configuration.

## Project Structure

- `src/`: application routes, shared components, and server modules; `@/*` resolves here.
- `public/`: static assets and the generated PDF.js worker.
- `tests/`, `scripts/`, and `migrations/`: automated checks, maintenance commands, and versioned database migrations.
- Root configuration files define Next.js, TypeScript, Tailwind/PostCSS, ESLint, and Playwright behavior. Application type checking covers `src/`, Next.js configuration, and generated route types.
- `submission-review/`: historical review evidence, preserved separately from application code.

New users select a goal and preferred mode, then enter an empty Library. Uploading is optional. Saved notes and PDFs belong to the signed-in user and survive refresh. Explain, conversational Quiz, Explain It Back, and five-question Practice use real AI after per-material consent. Voice role-play uses a configured private ElevenLabs Agent after separate microphone consent; no sample course material is inserted.

## Voice Role-Play

See [VOICE.md](VOICE.md) for the four server-only ElevenLabs settings, exact HTTPS custom-model and HMAC webhook URLs, private-agent configuration, recording restrictions, and live verification checklist. Migrations 005 and 006 add voice persistence and interruption state without deleting existing data. Calls use Backboard material context and the same exact Qwen model. Transcripts are saved, not audio. Limits are ten minutes per call and six starts per rolling day, with existing generation quotas. `npm run materials:cleanup` also reconciles voice sessions and retries ElevenLabs deletion. No hosting, tunnel, agent provisioning or scheduler is created automatically.

## AI Study

Set `BACKBOARD_API_KEY` in the server environment (never `NEXT_PUBLIC_`). Obtain it from your [Backboard dashboard](https://app.backboard.io/). Backboard routes every generation through `llm_provider: openrouter` and `model_name: qwen/qwen3-30b-a3b-instruct-2507`. There is no model fallback and no direct OpenRouter client or separate OpenRouter key. Live model access and account billing must be verified separately with a fictional material after configuring the key.

Ordinary upload, reading, and downloading never send content to AI services. The material's confirmation dialog precedes creation of an isolated Backboard assistant and document upload. Indexing must succeed before generation. Each conversation or practice attempt has a separate thread; automatic tutoring memory is scoped to that material's assistant. Practice generation uses memory off. Web search and tools are disabled. Provider credentials, IDs, object keys, and raw errors never enter API responses or logs.

Practice output is schema-validated (five unique questions, four distinct choices each, an answer index, topic, explanation, and source quotation). For pasted notes, source quotations are checked against the original text. PDFs rely on Backboard's indexed retrieval for grounding; this is not an independent semantic fact-checker. Invalid or insufficient output fails instead of being padded. Answer keys and explanations remain server-side until each answer is submitted; scores are calculated in application state, not by the model. AI can still make mistakes.

Migration 004 adds consent/context mappings, sessions, messages, generation operations, usage, practice, and durable provider-cleanup records without resetting existing data. Run `npm run db:migrate` before starting the updated application.

Generation uses 10 requests per rolling minute and 100 per rolling 24 hours per user, including generation retries. A material permits one active or uncertain operation. Messages are limited to 8,000 characters. A request key deduplicates repeated sends; database operation records include five-minute leases, partial output, and provider run/message identifiers. Client disconnects do not trigger an automatic replay. Use **Check saved result** to reconcile an interrupted request. If the provider cannot prove completion, the material remains blocked until recovery or a confirmed reset. Reset never retries the original generation and retains the original uploaded material.

Reset and material deletion immediately remove local AI access and queue remote cleanup. `npm run materials:cleanup` now processes both R2 and Backboard cleanup. AI cleanup waits ten minutes for in-flight calls to settle and retries failures after fifteen minutes; keep running the command periodically in production. It deletes associated documents, every page of threads, memory, and the assistant. Unknown creation outcomes are looked up by an opaque context name; an unresolved lookup stays queued rather than silently being discarded. No scheduler or deployment is installed by this change.

AI endpoints independently authenticate sessions, check ownership, reject foreign IDs, validate mutation origins, and return private/no-store responses:

- `GET/POST/DELETE /api/materials/:id/ai`: status, explicit consent/preparation, and reset.
- `GET/POST /api/study-sessions`: history and session creation; `GET/PATCH /:id`: messages and mode.
- `POST /api/study-sessions/:id/messages`, `/cancel`, `/recover`: streamed generation and recovery controls.
- `/api/practice` uses the same session and generation routes; `POST /:id/answers` validates and saves one answer.

Deploy on a Node server that permits streaming requests up to five minutes. A terminated process leaves a durable uncertain operation; it does not start an untracked replacement. Provider cleanup is a separate operational responsibility. The integration follows the official [Backboard message](https://docs.backboard.io/concepts/messages), [document](https://docs.backboard.io/sdk/documents), and [memory](https://docs.backboard.io/sdk/memory) APIs.

## Private R2 Storage

Create a private R2 bucket and a bucket-scoped Object Read & Write API token. Keep public access (r2.dev and custom domains) disabled. Configure these server-only variables:

- `R2_ENDPOINT`: your account's S3 API endpoint, such as `https://ACCOUNT_ID.r2.cloudflarestorage.com`.
- `R2_BUCKET`: the private bucket name.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: the bucket-scoped S3 credentials.

Never use `NEXT_PUBLIC_` for credentials or paste them into review artifacts. Requests pass through authenticated application endpoints, so browser-to-bucket CORS and public/presigned URLs are not needed. Pasted notes continue to work without R2 configuration.

Implementation follows [Cloudflare's AWS SDK v3 guide](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/). Live R2 upload/download/delete must be tested after configuration; mocked tests do not prove live access.

PDFs are limited to 20 MiB each. Notes are limited to 100,000 characters. Each account has a maximum of 100 material records and 500 MiB of PDF storage, including in-flight uploads and pending deletions. Mutation endpoints allow 10 attempts per account per minute. Titles are limited to 120 characters.

Uploads use bounded server-side body reads and validate the PDF signature, not full document semantics or malware safety. PDF.js renders page canvases without interactive annotations or embedded scripts. The original document is available as a private attachment. There is no local OCR, extraction pipeline, or antivirus service. Backboard indexes documents only after consent. Only open downloads from sources you trust.

## Recovery and Operations

Migration 003 creates material and mutation-rate tables and removes only the obsolete subject preference. It does not reset accounts or completion status. Migration checksums protect previous migrations.

Quota reservations are serialized by owner. Failed or interrupted PDF operations remain recorded until object cleanup succeeds; deleting files disappear immediately from the Library. Retry cleanup with:

```sh
npm run materials:cleanup
```

Each run processes up to 10 queued deletions or uploads abandoned for over one hour. Run it repeatedly to drain a backlog; arrange a regular scheduled invocation in a future deployment. PDF creation and deletion also retry one of the current owner's queued records. Failed uploads remain reserved for an hour before cleanup to avoid racing a late remote write. No background job or deployment is installed automatically. Storage outages can temporarily retain quota reservations; pasted-note saves do not wait for R2 cleanup.

The app server must allow request bodies of at least 20 MiB and enough time for authenticated storage requests. Check hosting limits before deploying; this implementation is not a direct-to-R2 upload design.

## APIs

All material endpoints verify the session independently and use private/no-store responses.

- `GET /api/materials`: owned material summaries and PDF-upload availability.
- `POST /api/materials`: JSON `{ title, notes }`, or raw `application/pdf` bytes with a URL-encoded `X-Material-Title` header.
- `GET /api/materials/:id`: owned material metadata and note text.
- `GET /api/materials/:id/content`: authenticated original PDF or text attachment.
- `DELETE /api/materials/:id`: remove from Library; response indicates whether file cleanup is pending.

Mutations require the configured application Origin. Owners are derived from the session, never request fields. Unknown and other users' IDs return 404. Internal object keys are never returned.

## Checks

```sh
npm run lint
npm run typecheck
npm run build
npx playwright install chromium
npm run test:db
npm run test:auth
npm run test:materials
npm run test:ai
npm run test:voice
npm run test:e2e
npm run test:db:stop
```

Tests use an isolated loopback PostgreSQL database and fictional fixtures. Google, R2, Backboard and ElevenLabs responses are mocked; browser PDF preview uses a generated test document and voice tests use synthetic microphone input. Checks cover ownership, quotas, cleanup, persistence, onboarding, consent, generation recovery, scoring, voice controls, signed transcripts, accessible controls, and responsive screenshots. No real user documents are used. Mocks do not prove live provider access.

The PDF.js worker is copied from the installed package during install/dev/build. Local review evidence remains in `submission-review`; nothing is uploaded automatically. Historical review records describe earlier prototypes and are preserved unchanged.
