import { test } from "node:test";
import assert from "node:assert/strict";
import { ElevenVoice } from "../src/lib/voice/elevenlabs";
import { voiceHandler } from "../src/lib/voice/handler";
import { VoiceService } from "../src/lib/voice/service";
import { StudyService } from "../src/lib/ai/service";
import { Backboard } from "../src/lib/ai/backboard";
import { Pool } from "pg";
import {
  classifyVoiceError,
  voiceErrorMessages,
} from "../src/lib/voice/errors";
import { voiceTrace, voiceReference } from "../src/lib/voice/trace";

test("voice diagnostics emit only opaque references and safe categories", () => {
  const previous = process.env.VOICE_TRACE;
  const log = console.info;
  const lines: string[] = [];
  console.info = (line: string) => lines.push(line);
  try {
    delete process.env.VOICE_TRACE;
    voiceTrace("private-session", "private-operation")("failed");
    assert.equal(lines.length, 0);
    process.env.VOICE_TRACE = "1";
    voiceTrace("private-session", "private-operation")("first_token");
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /private-session|private-operation/);
    const event = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(event).sort(), [
      "elapsedMs",
      "event",
      "operation",
      "reference",
      "scope",
    ]);
    assert.equal(event.reference, voiceReference("private-session"));
    assert.ok(event.elapsedMs >= 0);
  } finally {
    console.info = log;
    if (previous === undefined) delete process.env.VOICE_TRACE;
    else process.env.VOICE_TRACE = previous;
  }
  for (const [raw, code] of [
    ["NotAllowedError", "microphone_permission"],
    ["unauthorized 401 private payload", "provider_authentication"],
    ["llm timeout", "model_timeout"],
    ["llm error 1002", "generation_failure"],
    ["session expired", "session_expired"],
    ["network disconnected", "transport"],
  ] as const) {
    assert.equal(classifyVoiceError(raw), code);
    assert.doesNotMatch(voiceErrorMessages[code], /private payload/);
  }
});
import {
  agentFixture,
  createMockEleven,
  voiceConfig,
} from "./mock-elevenlabs.mjs";

test("an unconfigured primary model produces actionable setup errors, not a bad request", async () => {
  const mock = createMockEleven();
  const agent = agentFixture();
  Object.assign(agent.conversation_config.agent.prompt, {
    llm: "qwen3.5-397b",
    custom_llm: null,
  });
  mock.setAgent(agent);
  const provider = new ElevenVoice(voiceConfig, mock.transport);
  await assert.rejects(provider.validate(), (error) => {
    assert.equal((error as { status: number }).status, 503);
    assert.match((error as Error).message, /select Custom LLM/);
    return true;
  });
  // Configuration checks must not open a database connection or issue a token.
  const pool = new Pool();
  try {
    const response = await voiceHandler(
      new Request("http://localhost/api/voice-sessions/configuration"),
      {
        origin: "http://localhost",
        authenticate: async () => ({
          userId: "fixture",
          sessionId: "fixture-session",
        }),
        voice: new VoiceService(
          new StudyService(pool, new Backboard("fictional-key"), null),
          provider,
        ),
      },
      ["configuration"],
    );
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /select Custom LLM/);
    assert.doesNotMatch(
      body,
      /fictional-key|fictional-eleven-key|Invalid voice request/,
    );
  } finally {
    await pool.end();
  }
});

test("malformed provider configuration remains unavailable without exposing raw fields", async () => {
  const provider = new ElevenVoice(voiceConfig, async () =>
    Response.json({ platform_settings: "private-provider-value" }),
  );
  await assert.rejects(provider.validate(), (error) => {
    assert.equal((error as { status: number }).status, 503);
    assert.match((error as Error).message, /incomplete agent settings/);
    assert.doesNotMatch((error as Error).message, /private-provider-value/);
    return true;
  });
});

test("private authentication and recording errors explain required settings", async () => {
  const mock = createMockEleven();
  const provider = new ElevenVoice(voiceConfig, mock.transport);
  const agent = agentFixture();
  agent.platform_settings.auth.enable_auth = false;
  mock.setAgent(agent);
  await assert.rejects(provider.validate(), /enable authentication/);
  agent.platform_settings.auth.enable_auth = true;
  agent.platform_settings.privacy.record_voice = true;
  await assert.rejects(provider.validate(), /disable audio recording/);
  mock.setAgent(agentFixture());
  await provider.validate();
});

test("remaining configuration errors list all unmet settings without exposing values", async () => {
  const mock = createMockEleven();
  const agent = agentFixture();
  agent.conversation_config.agent.prompt.custom_llm.url =
    "https://private-provider.example/wrong?secret=private-token";
  agent.platform_settings.overrides.custom_llm_extra_body = false;
  agent.platform_settings.overrides.conversation_config_override.tts.speed = false;
  agent.conversation_config.turn.speculative_turn = true;
  agent.platform_settings.workspace_overrides.webhooks.post_call_webhook_id =
    "";
  mock.setAgent(agent);
  await assert.rejects(
    new ElevenVoice(voiceConfig, mock.transport).validate(),
    (error) => {
      assert.equal((error as { status: number }).status, 503);
      const message = (error as Error).message;
      for (const expected of [
        /Custom LLM Server URL/,
        /custom_llm_extra_body/,
        /TTS speed/,
        /Disable speculative turns/,
        /Select a post-call webhook/,
      ])
        assert.match(message, expected);
      assert.doesNotMatch(
        message,
        /private-provider|private-token|fictional-eleven-key/,
      );
      return true;
    },
  );
});

test("Custom LLM uses a base URL and rejects duplicate endpoint suffixes and unsafe URLs", async () => {
  const mock = createMockEleven();
  const provider = new ElevenVoice(voiceConfig, mock.transport);
  await provider.validate();
  for (const url of [
    "https://study.example.test/api/voice/llm/chat/completions",
    "https://study.example.test/api/voice/llm/chat/completions/chat/completions",
    "https://study.example.test/api/voice/llm/",
    "https://study.example.test/wrong",
    "http://study.example.test/api/voice/llm",
    "https://study.example.test/api/voice/llm?key=private",
    "https://study.example.test/api/voice/llm#fragment",
    "https://user:private@study.example.test/api/voice/llm",
  ]) {
    const agent = agentFixture();
    agent.conversation_config.agent.prompt.custom_llm.url = url;
    mock.setAgent(agent);
    await assert.rejects(provider.validate(), /Custom LLM Server URL/);
  }
});

test("token room binding accepts only a usable provider-issued conversation grant", async () => {
  const mock = createMockEleven();
  const issued = await new ElevenVoice(voiceConfig, mock.transport).token(
    "12345678-1234-1234-1234-123456789012",
  );
  assert.equal(issued.conversationId, "conv_12345678123412341234123456789012");
  for (const claims of [
    { exp: 1, video: { roomJoin: true, room: "conv_example" } },
    {
      exp: Date.now() / 1000 + 600,
      video: { roomJoin: false, room: "conv_example" },
    },
    {
      exp: Date.now() / 1000 + 600,
      video: { roomJoin: true, room: "unknown" },
    },
    {
      exp: Date.now() / 1000 + 600,
      video: { roomJoin: true, room: "conv_one conv_two" },
    },
  ]) {
    const provider = new ElevenVoice(voiceConfig, async () =>
      Response.json({
        token: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fictional`,
      }),
    );
    await assert.rejects(provider.token("fixture"), /could not be bound/);
  }
  const malformed = new ElevenVoice(voiceConfig, async () =>
    Response.json({ token: "private-malformed-token" }),
  );
  await assert.rejects(malformed.token("fixture"), (error) => {
    assert.doesNotMatch((error as Error).message, /private-malformed-token/);
    return true;
  });
});

test("empty dashboard workflows are inert but executable workflows remain blocked", async () => {
  const mock = createMockEleven();
  const provider = new ElevenVoice(voiceConfig, mock.transport);
  const start = {
    type: "start",
    position: { x: 0, y: 0 },
    edge_order: [],
    parent_subgraph_id: null,
  };
  const empty = {
    nodes: { start_node: start },
    edges: {},
    subgraphs: {},
    prevent_subagent_loops: true,
  };
  for (const workflow of [undefined, null, {}, empty]) {
    const agent = agentFixture();
    Object.assign(agent, { workflow });
    Object.assign(agent.conversation_config.agent.prompt, {
      built_in_tools: { end_call: null, skip_turn: null },
    });
    mock.setAgent(agent);
    await provider.validate();
  }
  for (const workflow of [
    { ...empty, nodes: { step: { type: "override_agent" } } },
    { ...empty, nodes: { step: { type: "dispatch_tool" } } },
    { ...empty, edges: { route: { source: "start_node", target: "step" } } },
    { ...empty, subgraphs: { nested: {} } },
    { ...empty, nodes: { start_node: { ...start, edge_order: ["route"] } } },
    {
      ...empty,
      nodes: { start_node: { ...start, additional_prompt: "Override" } },
    },
    { ...empty, nodes: { one: start, two: start } },
    { nodes: [] },
  ]) {
    mock.setAgent(Object.assign(agentFixture(), { workflow }));
    await assert.rejects(
      provider.validate(),
      /Disable agent tools and workflows/,
    );
  }
  const agent = Object.assign(agentFixture(), { workflow: empty });
  Object.assign(agent.platform_settings.overrides, { workflow: true });
  mock.setAgent(agent);
  await assert.rejects(
    provider.validate(),
    /Disable agent tools and workflows/,
  );
  Object.assign(agent.platform_settings.overrides, { workflow: false });
  Object.assign(agent.conversation_config.agent.prompt, {
    built_in_tools: { end_call: {} },
  });
  await assert.rejects(
    provider.validate(),
    /Disable agent tools and workflows/,
  );
});
