# Voice role-play setup

The app uses a private ElevenLabs Agent for WebRTC audio, transcription,
turn-taking and speech. Each call has its own Backboard thread under the
material's existing assistant. Generation is always routed by Backboard through
OpenRouter to `qwen/qwen3-30b-a3b-instruct-2507`. There is no model fallback or
direct OpenRouter client.

## Server configuration

Keep existing credentials unchanged. Set these server-only values in
`.env.local` for local use, or your host's secret manager:

- `ELEVENLABS_API_KEY`: a restricted key with agent/voice/webhook read access,
  conversation token issuance, and conversation read/delete access.
- `ELEVENLABS_AGENT_ID`: the private stock-voice agent you configure below.
- `ELEVENLABS_LLM_SECRET`: an independently generated random secret of at least
  32 characters, also stored as the agent's Custom LLM API-key secret.
- `ELEVENLABS_WEBHOOK_SECRET`: the signing secret supplied when creating your
  HMAC webhook. This is not the API key or Custom LLM secret.

Existing `BACKBOARD_API_KEY`, database/auth configuration, and R2 for PDF material
preparation are also required. No `NEXT_PUBLIC_` credentials are used.
Apply additive migrations with `npm run db:check` then `npm run db:migrate`.
Never reset the database for this feature.

## Configure the agent yourself

No agent, public host or tunnel has been provisioned. A publicly reachable HTTPS
host is required for callbacks. `localhost` is not reachable from ElevenLabs.
With a public host `https://your-study-host.example`, use:

| Setting | Required value |
| --- | --- |
| Custom LLM Server URL (editable field) | `https://your-study-host.example/api/voice/llm` |
| API format | OpenAI Chat Completions, streaming |
| Model ID | `qwen/qwen3-30b-a3b-instruct-2507` |
| API key | Secret containing `ELEVENLABS_LLM_SECRET`; sent as Bearer authorization |
| Backup LLM | Disabled |
| Post-call webhook URL | `https://your-study-host.example/api/voice/webhook` |
| Webhook authentication | HMAC, matching `ELEVENLABS_WEBHOOK_SECRET` |
| Webhook events | Transcript; optionally call initiation failure; no audio |
| Webhook format | Native ElevenLabs conversation JSON, not OpenTelemetry |
| Authentication | Required/private agent |
| Maximum duration | 600 seconds |
| Language | English |
| Voice | One stock/premade voice, not a clone |
| First message | A neutral greeting, e.g. "What would you like to discuss from your material?" |
| Tools, MCP, workflows, agent knowledge base | None; Backboard owns material context |
| Speculative turns | Disabled, to avoid speculative billable requests |
| Interruptions | Enabled; first-message interruption allowed |
| Audio recording | Disabled (`record_voice: false`, `delete_audio: true`) |
| Transcript retention | Between 1 and 7 days |
| Zero retention | Off: verified final transcript retrieval is required |
| Client overrides | Only TTS speed and `custom_llm_extra_body`; no prompt/model/voice/duration overrides |

Set a conservative agent token budget and silence timeout. Do not add a separate
provider knowledge base or generative first message. The application supplies
role and speaking style to Backboard, not through a client-overridable prompt.
Keep full turn history in custom-LLM requests for persisted request fingerprints.
Revised learner utterances are distinct from exact retries, even when the message
count stays unchanged. The bridge sends only the newest learner turn to Backboard.
Provider idle continuations ending in assistant/system messages receive an
authenticated neutral listening response without new generation or replay, but
are rejected when an existing generation remains unresolved. Confirmed
Backboard cancellations end their response stream normally; provider failures
and uncertain outcomes still surface as errors and are not blindly retried.

The bridge immediately streams an assistant-role chunk with no spoken filler,
then emits SSE keep-alive comments during idle periods. Empty chunks and comments
must not be assumed to satisfy the provider's first-content deadline.
For controlled latency testing, set `agent.prompt.cascade_timeout_seconds` to 15
(the documented maximum), retaining disabled backup models. The configured agent
was changed from 4 to 15 after a live timeout closed a request at about 3.75 seconds.
This setting's effect on custom-model retries with backups disabled requires live
verification; it is not proof of timeout recovery. Do not enable fallback models
or replay cancelled/uncertain operations to compensate for latency.

The Chat Completions dashboard adds `/chat/completions` to the Server URL.
Enter only the base URL ending in `/api/voice/llm`, without a trailing slash.
The resulting request endpoint is `/api/voice/llm/chat/completions`; entering
that full endpoint in the editable field would duplicate the suffix.

The configuration endpoint validates the agent, stock voice and enabled HMAC
webhook on the custom-model host before issuing tokens. It cannot verify a
secret's value remotely or prove HTTPS reachability; complete the live check
below. Unsupported configuration fails closed. User-configured tunnels are
possible, but no tunnel is started automatically. Keep auth origin and Google
callback settings consistent with whichever browser origin you use.

## Privacy and lifecycle

- Material preparation consent is separate from voice consent. Microphone access
  is requested only after the user accepts voice consent and starts a call.
- The browser gets an ephemeral WebRTC token and a session-scoped capability,
  never provider API keys. Capabilities are hashed at rest, bound to an
  authenticated app session and provider-verified conversation, and expire at
  the application's ten-minute deadline.
- The server extracts the conversation room from the token returned directly
  by the authenticated ElevenLabs token endpoint and persists that mapping before
  returning the token. It never decodes a client-supplied token for authorization.
  Binding checks that the browser's conversation ID matches this server-recorded
  room; live REST initiation metadata is not required. Older unmapped sessions
  still require matching provider identity and capability metadata. Final
  transcripts remain signature-verified or fetched with server credentials.
- The application saves text transcripts, consent, timestamps, preferences,
  generated responses and lifecycle records. It never archives audio in
  PostgreSQL, R2 or review evidence. ElevenLabs processes audio and can retain
  transcripts for the configured period; this is not an enterprise zero-retention
  promise. Backboard retains the material/thread/memory under its own policy.
- Live browser captions are provisional. Only HMAC-verified webhooks or
  authenticated provider retrieval produce the saved spoken transcript.
  Interrupted generated responses remain separate from delivered speech.
- Mute does not suspend time or provider usage. Explicit End, navigation,
  sign-out/unmount and the browser deadline disconnect the SDK. Server callbacks
  also reject expired, ended or revoked sessions. The provider's independent
  600-second limit is the backstop if the browser disappears.
- One active call per user/material. The daily session-start cap is temporarily
  removed; start records remain for duplicate-request protection. Existing ten
  generations per minute and 100 per day still apply. No automatic reconnect
  or new call after refresh. Provider usage and billing limits still apply.
- Repeated turns return the persisted result or an unresolved error. They never
  blindly repeat potentially billed generation. End an unresolved call and open
  its saved transcript before attempting another.

## Cleanup and recovery

Run `npm run materials:cleanup` from your existing private job runner regularly
(for example every few minutes). This task does not create a scheduler.
The command recovers expired calls and missed transcripts, then retries durable
ElevenLabs, Backboard and R2 deletion queues. It needs the same server secrets.
Deleting a material or resetting its AI data immediately revokes local voice
access and removes local transcripts. Provider deletion is asynchronous and
retries on outage. Unknown provider outcomes remain queued for reconciliation;
they are not silently treated as successful deletion. Monitor queue size and
attempt counts without logging provider payloads, material text or secrets.

## Verification

### Controlled fault isolation

Tracing is off by default. Set server-only `VOICE_TRACE=1` to record stage names,
elapsed milliseconds and hashed diagnostic references. No prompts, transcripts,
audio, credentials or raw provider payloads are logged. The reference shown on
a failed call matches the server trace reference. Do not enable HTTP body logging.

The standalone fictional Backboard probe is explicitly opt-in:

```sh
node --conditions=react-server --import tsx scripts/probe-voice-backboard.ts --live
```

It spends provider credits, checks first output and successful completion, and
removes its temporary provider resources. Failed cleanup remains in the existing
durable cleanup queue. It does not reuse any user's conversations or materials.

To isolate ElevenLabs, create and prepare a pasted material containing exactly:

```text
Fictional study note: A solar cart uses a panel to charge a battery. The battery stores energy and powers a small motor.
```

Choose a new session UUID and the authenticated test user's application user ID.
Set these server-only variables for the diagnostic run, then restart the server:

```text
VOICE_DIAGNOSTIC_MODE=deterministic
VOICE_DIAGNOSTIC_SESSION_ID=<new-session-uuid>
VOICE_DIAGNOSTIC_USER_ID=<authenticated-test-user-id>
VOICE_TRACE=1
```

Open `/voice?material=<fictional-material-id>&diagnosticSession=<new-session-uuid>`
as that user. Start still requires consent, authentication, ownership, preparation,
the private provider token and microphone permission. Only this selected session
with the exact fictional note bypasses Backboard generation; it streams a fixed
answer. Other sessions are unchanged. Existing generation quotas still apply.

With the user operating the microphone, check five turns, three interruptions
followed by new answers, silence/resume, mute/unmute, End, and saved-transcript
refresh. Test navigation and the ten-minute deadline separately. Record only
diagnostic references, stages, timings and pass/fail results. Do not record audio.

After the isolated test, remove all three `VOICE_DIAGNOSTIC_*` values, restart,
and remove `diagnosticSession` from the URL. Run the same checks in a new normal
session to test the combined pipeline. Disable `VOICE_TRACE` afterwards. Do not
retry unresolved billable operations. Mocked tests are not live-call acceptance.

Automated tests use an isolated PostgreSQL database and mocked providers. The
browser SDK fixture is selected only on the explicit isolated development test
server; production always uses the official ElevenLabs React SDK.

```sh
npm run test:db
npm run test:voice
npm run test:ai
npm run test:e2e
npm run lint
npm run typecheck
npm run build
```

Live verification remains a separate, user-participating step after configuration:
use fictional notes; prepare them; accept voice consent; test both roles,
interruptions, mic/speaker mute, network loss, navigation, ten-minute ending,
verified saved transcript, and deletion. Confirm no audio is retained in the
provider dashboard. Check real latency, callback authentication and exact model
routing. Mock tests do not establish live provider access or audio quality.

Official references: [React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react),
[Custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm),
[post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks),
[privacy settings](https://elevenlabs.io/docs/eleven-agents/customization/privacy).
