import "server-only";
import { z } from "zod";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { MaterialError } from "../materials/repository";
import { MODEL } from "../ai/backboard";

const configuration = z.object({
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_AGENT_ID: z.string().min(1),
  ELEVENLABS_LLM_SECRET: z.string().min(32),
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(16),
});
export type VoiceConfig = z.infer<typeof configuration>;
export function readVoiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = configuration.safeParse(env);
  return parsed.success ? parsed.data : null;
}
const map = z.record(z.string(), z.unknown());
const object = (value: unknown) => map.parse(value);
// The dashboard saves a lone, disconnected start node even without a workflow.
const inactiveWorkflow = z.strictObject({
  edges: z.record(z.string(), z.never()).default({}),
  nodes: z
    .record(
      z.string(),
      z.strictObject({
        type: z.literal("start"),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        edge_order: z.array(z.never()).optional(),
        parent_subgraph_id: z.null().optional(),
      }),
    )
    .refine((nodes) => Object.keys(nodes).length <= 1)
    .default({}),
  subgraphs: z.record(z.string(), z.never()).default({}),
  prevent_subagent_loops: z.boolean().optional(),
});
export const conversationSchema = z.object({
  conversation_id: z.string(),
  agent_id: z.string(),
  status: z.string(),
  user_id: z.string().nullish(),
  conversation_initiation_client_data: z
    .object({
      user_id: z.string().nullish(),
      custom_llm_extra_body: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "agent"]),
        message: z.string().max(100_000).nullish(),
        time_in_call_secs: z.number().nonnegative(),
      }),
    )
    .max(1000)
    .default([]),
});
export type RemoteConversation = z.infer<typeof conversationSchema>;
export class ElevenVoice {
  constructor(
    public config: VoiceConfig,
    private transport: typeof fetch = fetch,
  ) {}
  async request(path: string, method = "GET") {
    const response = await this.transport(
      `https://api.elevenlabs.io/v1${path}`,
      {
        method,
        headers: { "xi-api-key": this.config.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
        redirect: "error",
      },
    );
    if (method === "DELETE" && response.status === 404) return null;
    if (!response.ok)
      throw new MaterialError(
        503,
        "The voice provider is unavailable. Please try again later.",
      );
    return response.status === 204 ? null : response.json();
  }
  async validate() {
    try {
      await this.validateAgent();
    } catch (error) {
      if (error instanceof z.ZodError)
        throw new MaterialError(
          503,
          "ElevenLabs returned incomplete agent settings. Check the Custom LLM, privacy, overrides and transcript webhook settings in VOICE.md, then save the agent configuration.",
        );
      throw error;
    }
  }
  private async validateAgent() {
    const agent = object(
      await this.request(
        `/convai/agents/${encodeURIComponent(this.config.ELEVENLABS_AGENT_ID)}`,
      ),
    );
    const platform = object(agent.platform_settings),
      config = object(agent.conversation_config);
    const privacy = object(platform.privacy),
      auth = object(platform.auth),
      overrides = object(platform.overrides);
    const conversation = object(config.conversation),
      agentConfig = object(config.agent),
      prompt = object(agentConfig.prompt),
      tts = object(config.tts);
    if (prompt.llm !== "custom-llm" || !prompt.custom_llm)
      throw new MaterialError(
        503,
        "ElevenLabs setup required: select Custom LLM as the primary model, configure the Study Partner endpoint and API-key secret, then save/publish the agent changes. The configured agent does not have a Custom LLM endpoint yet.",
      );
    const custom = object(prompt.custom_llm);
    if (auth.enable_auth !== true)
      throw new MaterialError(
        503,
        "ElevenLabs setup required: enable authentication so the agent is private, then save the agent changes.",
      );
    if (privacy.record_voice !== false || privacy.delete_audio !== true)
      throw new MaterialError(
        503,
        "ElevenLabs setup required: disable audio recording and enable audio deletion in the agent privacy settings.",
      );
    if (
      privacy.zero_retention_mode === true ||
      !Number.isInteger(privacy.retention_days) ||
      Number(privacy.retention_days) < 1 ||
      Number(privacy.retention_days) > 7
    )
      throw new MaterialError(
        503,
        "ElevenLabs setup required: set transcript retention to 1-7 days and disable zero retention so the final transcript can be recovered.",
      );
    const backup = object(prompt.backup_llm_config);
    if (backup.preference !== "disabled")
      throw new MaterialError(
        503,
        "ElevenLabs setup required: set Backup LLM configuration to Disabled.",
      );
    const webhook = object(object(platform.workspace_overrides).webhooks);
    const allowedOverrides = object(overrides.conversation_config_override);
    const events = z.array(z.string()).parse(webhook.events);
    const url = new URL(z.url().parse(custom.url));
    const noTools = [
      prompt.tools,
      prompt.tool_ids,
      prompt.mcp_server_ids,
      prompt.native_mcp_server_ids,
      prompt.knowledge_base,
    ].every(
      (value) =>
        value === undefined || (Array.isArray(value) && value.length === 0),
    );
    const builtins = prompt.built_in_tools;
    if (
      (builtins && Object.values(object(builtins)).some(Boolean)) ||
      (agent.workflow != null &&
        !inactiveWorkflow.safeParse(agent.workflow).success) ||
      overrides.workflow === true
    )
      throw new MaterialError(
        503,
        "Disable agent tools and workflows for material-only voice calls.",
      );
    // Report every unmet setting using fixed text, never provider values or secrets.
    const requirements: [unknown, string][] = [
      [custom.model_id !== MODEL, `Set the Custom LLM model ID to ${MODEL}.`],
      [
        custom.api_type !== undefined && custom.api_type !== "chat_completions",
        "Use the Chat Completions API format.",
      ],
      [
        url.protocol !== "https:" ||
          url.pathname !== "/api/voice/llm" ||
          url.search ||
          url.hash ||
          url.username ||
          url.password,
        "Set the Custom LLM Server URL to your public HTTPS host followed by /api/voice/llm. ElevenLabs appends /chat/completions; do not include that suffix, a trailing slash, query, fragment or embedded credentials.",
      ],
      [
        conversation.max_duration_seconds !== 600,
        "Set maximum conversation duration to 600 seconds.",
      ],
      [conversation.text_only === true, "Disable text-only mode."],
      [
        overrides.custom_llm_extra_body !== true,
        "Enable the custom_llm_extra_body client override.",
      ],
      [
        object(allowedOverrides.tts).speed !== true,
        "Enable the TTS speed client override.",
      ],
      [
        object(config.turn).speculative_turn !== false,
        "Disable speculative turns.",
      ],
      [agentConfig.language !== "en", "Set the agent language to English."],
      [
        agentConfig.disable_first_message_interruptions === true,
        "Allow first-message interruptions.",
      ],
      [!agentConfig.first_message, "Set a neutral first message."],
      [!tts.voice_id, "Select a stock voice."],
      [
        !noTools,
        "Remove attached tools, MCP servers and agent knowledge-base documents.",
      ],
      [
        !webhook.post_call_webhook_id,
        "Select a post-call webhook for this agent.",
      ],
      [
        !events.includes("transcript") ||
          events.some(
            (e) => !["transcript", "call_initiation_failure"].includes(e),
          ) ||
          webhook.send_audio === true,
        "Enable transcript webhook events and disable audio webhook events.",
      ],
      [
        webhook.transcript_format !== undefined &&
          webhook.transcript_format !== "json",
        "Use JSON transcript webhook format.",
      ],
      [!custom.api_key, "Select the Custom LLM API-key secret."],
    ];
    const unmet = requirements
      .filter(([failed]) => failed)
      .map(([, message]) => message);
    if (unmet.length) {
      throw new MaterialError(
        503,
        `ElevenLabs setup required: ${unmet.join(" ")}`,
      );
    }
    // Allow speed alone; clients must not override the model, voice, prompt or duration.
    const hasEnabled = (value: unknown): boolean =>
      value === true ||
      (typeof value === "object" &&
        value !== null &&
        Object.values(value).some(hasEnabled));
    if (
      Object.entries(allowedOverrides).some(
        ([key, value]) => key !== "tts" && hasEnabled(value),
      ) ||
      Object.entries(object(allowedOverrides.tts)).some(
        ([key, value]) => key !== "speed" && hasEnabled(value),
      )
    )
      throw new MaterialError(
        503,
        "Disable unsafe voice-agent client overrides.",
      );
    const voice = object(
      await this.request(`/voices/${encodeURIComponent(String(tts.voice_id))}`),
    );
    if (voice.category !== "premade")
      throw new MaterialError(
        503,
        "Configure a stock ElevenLabs voice, not a cloned voice.",
      );
    const hooks = z
      .object({ webhooks: z.array(map) })
      .parse(await this.request("/workspace/webhooks"));
    const hook = hooks.webhooks.find(
      (item) => item.webhook_id === webhook.post_call_webhook_id,
    );
    if (
      !hook ||
      hook.webhook_url !== `${url.origin}/api/voice/webhook` ||
      hook.auth_type !== "hmac" ||
      hook.is_disabled !== false ||
      hook.is_auto_disabled !== false
    )
      throw new MaterialError(
        503,
        "Configure an enabled HMAC transcript webhook on the same HTTPS host as the custom model.",
      );
  }
  async token(alias: string) {
    const { token } = z
      .object({ token: z.string().min(1) })
      .parse(
        await this.request(
          `/convai/conversation/token?agent_id=${encodeURIComponent(this.config.ELEVENLABS_AGENT_ID)}&participant_name=${encodeURIComponent(alias)}`,
        ),
      );
    // This token comes directly from the authenticated provider response, never
    // from a client. Its room grant binds our session before live REST is ready.
    try {
      const claims = z
        .object({
          exp: z.number(),
          video: z.object({ roomJoin: z.literal(true), room: z.string() }),
        })
        .parse(
          JSON.parse(
            Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
          ),
        );
      const ids = claims.video.room.match(/conv_[a-zA-Z0-9]+/g);
      if (claims.exp <= Date.now() / 1000 || ids?.length !== 1)
        throw new Error();
      return { token, conversationId: ids[0] };
    } catch {
      throw new MaterialError(
        503,
        "The provider token could not be bound to a voice conversation. Check the saved session before retrying.",
      );
    }
  }
  async conversation(id: string) {
    return conversationSchema.parse(
      await this.request(`/convai/conversations/${encodeURIComponent(id)}`),
    );
  }
  async find(alias: string) {
    const result = z
      .object({
        conversations: z.array(z.object({ conversation_id: z.string() })),
        has_more: z.boolean().optional(),
      })
      .parse(
        await this.request(
          `/convai/conversations?agent_id=${encodeURIComponent(this.config.ELEVENLABS_AGENT_ID)}&user_id=${encodeURIComponent(alias)}&page_size=100`,
        ),
      );
    if (result.has_more)
      throw new MaterialError(503, "Voice recovery needs attention.");
    return result.conversations;
  }
  async remove(id: string) {
    await this.request(
      `/convai/conversations/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
  async webhook(raw: string, signature: string) {
    const timestamp = Number(
      signature
        .split(",")
        .find((s) => s.startsWith("t="))
        ?.slice(2),
    );
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 1800
    )
      throw new MaterialError(401, "Invalid webhook signature.");
    try {
      return (await new ElevenLabsClient({
        apiKey: this.config.ELEVENLABS_API_KEY,
      }).webhooks.constructEvent(
        raw,
        signature,
        this.config.ELEVENLABS_WEBHOOK_SECRET,
      )) as unknown;
    } catch {
      throw new MaterialError(401, "Invalid webhook signature.");
    }
  }
}
