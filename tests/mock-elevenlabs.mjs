// Isolated test transport. No audio or real provider calls.
export const voiceConfig = {
  ELEVENLABS_API_KEY: "fictional-eleven-key",
  ELEVENLABS_AGENT_ID: "fictional-agent",
  ELEVENLABS_LLM_SECRET: "fictional-llm-secret-for-isolated-tests-only",
  ELEVENLABS_WEBHOOK_SECRET: "fictional-webhook-secret",
};
export function agentFixture() {
  return {
    platform_settings: {
      auth: { enable_auth: true },
      privacy: {
        record_voice: false,
        delete_audio: true,
        retention_days: 7,
        zero_retention_mode: false,
      },
      overrides: {
        custom_llm_extra_body: true,
        conversation_config_override: { tts: { speed: true } },
      },
      workspace_overrides: {
        webhooks: {
          post_call_webhook_id: "fictional-hook",
          events: ["transcript"],
          send_audio: false,
        },
      },
    },
    conversation_config: {
      conversation: { max_duration_seconds: 600, text_only: false },
      turn: { speculative_turn: false },
      tts: { voice_id: "fictional-stock" },
      agent: {
        language: "en",
        first_message: "What would you like to discuss?",
        prompt: {
          llm: "custom-llm",
          custom_llm: {
            url: "https://study.example.test/api/voice/llm",
            model_id: "qwen/qwen3-30b-a3b-instruct-2507",
            api_key: { secret_id: "fictional-secret" },
          },
          backup_llm_config: { preference: "disabled" },
          tools: [],
          knowledge_base: [],
        },
      },
    },
  };
}
export function remoteFixture(alias, capability, status = "in-progress") {
  return {
    conversation_id: `conv_${alias.replaceAll("-", "")}`,
    agent_id: voiceConfig.ELEVENLABS_AGENT_ID,
    user_id: alias,
    status,
    conversation_initiation_client_data: {
      user_id: alias,
      custom_llm_extra_body: { voice_capability: capability },
    },
    transcript: [
      { role: "user", message: "Explain the solar cart", time_in_call_secs: 1 },
      {
        role: "agent",
        message: "The battery stores energy.",
        time_in_call_secs: 3,
      },
    ],
  };
}
export function createMockEleven() {
  const conversations = new Map();
  const deleted = [];
  let agent = agentFixture();
  async function transport(input, init) {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/workspace/webhooks"))
      return Response.json({
        webhooks: [
          {
            webhook_id: "fictional-hook",
            webhook_url: "https://study.example.test/api/voice/webhook",
            auth_type: "hmac",
            is_disabled: false,
            is_auto_disabled: false,
          },
        ],
      });
    if (url.pathname.includes("/agents/")) return Response.json(agent);
    if (url.pathname.includes("/voices/"))
      return Response.json({ category: "premade" });
    if (url.pathname.endsWith("/conversation/token"))
      return Response.json({
        token: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, video: { roomJoin: true, room: `conv_${url.searchParams.get("participant_name").replaceAll("-", "")}` } })).toString("base64url")}.fictional`,
      });
    if (url.pathname.endsWith("/conversations"))
      return Response.json({
        conversations: [...conversations.values()]
          .filter((c) => c.user_id === url.searchParams.get("user_id"))
          .map((c) => ({ conversation_id: c.conversation_id })),
        has_more: false,
      });
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    if (init?.method === "DELETE") {
      deleted.push(id);
      conversations.delete(id);
      return new Response(null, { status: 204 });
    }
    // Browser fixture derives a fictional alias from its provider-issued room.
    if (!conversations.has(id) && /^conv_[a-f0-9]{32}$/.test(id)) {
      const alias = id
        .slice(5)
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
      conversations.set(id, remoteFixture(alias, undefined, "done"));
    }
    return conversations.has(id)
      ? Response.json(conversations.get(id))
      : Response.json({}, { status: 404 });
  }
  return {
    transport,
    conversations,
    deleted,
    setAgent(value) {
      agent = value;
    },
  };
}
export const browserEleven = createMockEleven();
