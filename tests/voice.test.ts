import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Backboard, MODEL } from "../src/lib/ai/backboard";
import { StudyService } from "../src/lib/ai/service";
import {
  createMaterial,
  deleteMaterial,
  MaterialError,
} from "../src/lib/materials/repository";
import {
  ElevenVoice,
  readVoiceConfig,
} from "../src/lib/voice/elevenlabs";
import { VoiceService, maintainVoice } from "../src/lib/voice/service";
import { voiceHandler } from "../src/lib/voice/handler";
import { DIAGNOSTIC_NOTES } from "../src/lib/voice/diagnostic";
import { fixtureNotes, mockBackboard } from "./mock-backboard.mjs";
import {
  agentFixture,
  createMockEleven,
  remoteFixture,
  voiceConfig,
} from "./mock-elevenlabs.mjs";
const pool = new Pool({
  connectionString:
    "postgresql://study_test@127.0.0.1:55439/study_partner_test",
});
const owners: string[] = [];
const origin = "http://localhost:3100";
async function setup() {
  const owner = randomUUID(),
    authId = randomUUID();
  owners.push(owner);
  await pool.query(
    'INSERT INTO study_partner."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Fixture\',$2,true,now(),now())',
    [owner, `${owner}@example.test`],
  );
  await pool.query(
    'INSERT INTO study_partner.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 day\',now(),now())',
    [authId, owner, randomUUID()],
  );
  const calls: { path: string; init?: RequestInit }[] = [];
  const backboard = new Backboard("fictional-key", async (input, init) => {
    calls.push({ path: String(input), init });
    return mockBackboard(input, init);
  });
  const study = new StudyService(pool, backboard, null);
  const material = await createMaterial(pool, null, owner, {
    title: "Fictional solar cart",
    notes: fixtureNotes,
  });
  await study.prepare(owner, material.id);
  const mock = createMockEleven();
  const provider = new ElevenVoice(voiceConfig, mock.transport);
  const voice = new VoiceService(study, provider);
  const identity = { userId: owner, sessionId: authId };
  const services = {
    voice,
    origin,
    authenticate: async () => identity as typeof identity | null,
  };
  async function request(
    path: string[],
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return voiceHandler(
      new Request(`${origin}/api/voice-sessions/${path.join("/")}`, {
        method,
        headers: { origin, "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      services,
      path,
    );
  }
  async function start(role: "Classmate" | "Mock Examiner" = "Classmate") {
    const result = await voice.start(identity, {
      id: randomUUID(),
      materialId: material.id,
      role,
    });
    const remote = remoteFixture(result.alias, result.capability);
    mock.conversations.set(remote.conversation_id, remote);
    await voice.bind(
      await voice.row(result.session.id),
      remote.conversation_id,
    );
    return { ...result, remote };
  }
  return {
    owner,
    authId,
    calls,
    study,
    backboard,
    material,
    mock,
    provider,
    voice,
    identity,
    services,
    request,
    start,
  };
}
after(async () => {
  for (const owner of owners) {
    await pool.query("DELETE FROM study_partner.materials WHERE user_id=$1", [
      owner,
    ]);
    await pool.query('DELETE FROM study_partner."user" WHERE id=$1', [owner]);
  }
  await pool.end();
});
test("connection binding waits for provider metadata without accepting mismatches or revoked calls", async () => {
  const a = await setup();
  const result = await a.voice.start(a.identity, {
    id: randomUUID(),
    materialId: a.material.id,
    role: "Classmate",
  });
  const remote = remoteFixture(result.alias, result.capability);
  // Legacy sessions did not persist the provider-issued token room.
  await pool.query(
    "UPDATE study_partner.voice_sessions SET provider_id=NULL WHERE id=$1",
    [result.session.id],
  );
  let reads = 0;
  a.provider.conversation = async () => {
    reads++;
    if (reads === 1) throw new MaterialError(503, "Provider not ready");
    if (reads === 2)
      return {
        ...remote,
        user_id: null,
        conversation_initiation_client_data: null,
      };
    return remote;
  };
  const saved = await a.voice.bind(
    await a.voice.row(result.session.id),
    remote.conversation_id,
  );
  assert.equal(saved.status, "active");
  assert.equal(reads, 3);
  await pool.query(
    "UPDATE study_partner.voice_sessions SET provider_id=NULL WHERE id=$1",
    [result.session.id],
  );
  a.provider.conversation = async () => ({ ...remote, user_id: "wrong-owner" });
  await assert.rejects(
    a.voice.bind(await a.voice.row(result.session.id), remote.conversation_id),
    { status: 403 },
  );
  a.provider.conversation = async () => ({
    ...remote,
    conversation_initiation_client_data: {
      custom_llm_extra_body: { voice_capability: "wrong" },
    },
  });
  await assert.rejects(
    a.voice.bind(await a.voice.row(result.session.id), remote.conversation_id),
    { status: 403 },
  );
  reads = 0;
  a.provider.conversation = async () => {
    reads++;
    await a.voice.end(a.owner, result.session.id);
    throw new MaterialError(503, "Not ready");
  };
  await assert.rejects(
    a.voice.bind(await a.voice.row(result.session.id), remote.conversation_id),
    { status: 403 },
  );
  assert.equal(reads, 1);
});

test("connection verification retries are bounded and never activate incomplete identity", async () => {
  const a = await setup();
  const result = await a.voice.start(a.identity, {
    id: randomUUID(),
    materialId: a.material.id,
    role: "Classmate",
  });
  const remote = remoteFixture(result.alias, result.capability);
  await pool.query(
    "UPDATE study_partner.voice_sessions SET provider_id=NULL WHERE id=$1",
    [result.session.id],
  );
  let reads = 0;
  a.provider.conversation = async () => {
    reads++;
    return { ...remote, conversation_initiation_client_data: null };
  };
  await assert.rejects(
    a.voice.bind(await a.voice.row(result.session.id), remote.conversation_id),
    { status: 503 },
  );
  assert.equal(reads, 4);
  assert.equal((await a.voice.row(result.session.id)).provider_id, null);
  assert.equal((await a.voice.row(result.session.id)).status, "starting");
});

test("provider-issued rooms bind before live conversation metadata exists", async () => {
  const a = await setup();
  const result = await a.voice.start(a.identity, {
    id: randomUUID(),
    materialId: a.material.id,
    role: "Classmate",
  });
  const remote = remoteFixture(result.alias, result.capability);
  assert.equal(
    (await a.voice.row(result.session.id)).provider_id,
    remote.conversation_id,
  );
  a.provider.conversation = async () => {
    throw new Error("Live metadata is unavailable");
  };
  a.provider.find = async () => {
    throw new Error("Live listing is unavailable");
  };
  await assert.rejects(
    a.voice.bind(await a.voice.row(result.session.id), "conv_forged"),
    { status: 403 },
  );
  const bound = await a.voice.bind(
    await a.voice.row(result.session.id),
    remote.conversation_id,
  );
  assert.equal(bound.status, "active");
  const turn = await a.voice.bridge(result.capability, [
    { role: "user", content: "Explain the solar cart" },
  ]);
  assert.equal(turn.row.id, result.session.id);
  const row = await a.voice.row(result.session.id);
  assert.equal(
    a.voice.matches(row, {
      ...remote,
      conversation_initiation_client_data: null,
    }),
    true,
  );
  assert.equal(a.voice.matches(row, { ...remote, agent_id: "wrong" }), false);
  assert.equal(a.voice.matches(row, { ...remote, user_id: "wrong" }), false);
  assert.equal(
    a.voice.matches(row, {
      ...remote,
      conversation_id: "conv_forged",
      conversation_initiation_client_data: null,
    }),
    false,
  );
  await a.voice.end(a.owner, result.session.id);
  await assert.rejects(a.voice.bind(row, remote.conversation_id), {
    status: 403,
  });
});

test("late cancellation of an old turn cannot cancel a newer generation", async () => {
  const a = await setup(),
    call = await a.start();
  const first = await a.voice.bridge(call.capability, [
    { role: "user", content: "First question" },
  ]);
  await a.voice.generate(first.row, first.turn, first.content, () => {});
  const second = await a.voice.bridge(call.capability, [
    { role: "user", content: "First question" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Second question" },
  ]);
  const reservation = await a.study.reserve(
    a.owner,
    call.session.id,
    second.turn.request_key,
    second.content,
    call.session.id,
  );
  await a.voice.cancelTurn(a.owner, call.session.id, first.turn.request_key);
  const current = await a.study.operation(
    a.owner,
    call.session.id,
    reservation.op.id,
  );
  assert.equal(current.cancel_requested, false);
  assert.equal(current.status, "running");
  await a.study.cancel(a.owner, call.session.id, reservation.op.id);
  await a.study.finish(a.owner, reservation.op, "", true);
});

test("voice finalization uses its own operation even when a later operation exists", async () => {
  const a = await setup(),
    call = await a.start();
  const original = a.study.run.bind(a.study);
  a.study.run = async (...args) => {
    await original(...args);
    await pool.query(
      "INSERT INTO study_partner.ai_operations(id,user_id,material_id,session_id,request_key,fingerprint,status) VALUES($1,$2,$3,$4,$5,'later','failed')",
      [randomUUID(), a.owner, a.material.id, call.session.id, randomUUID()],
    );
  };
  const turn = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain" },
  ]);
  await a.voice.generate(turn.row, turn.turn, turn.content, () => {});
  const saved = (
    await pool.query(
      "SELECT status,response FROM study_partner.voice_turns WHERE session_id=$1",
      [call.session.id],
    )
  ).rows[0];
  assert.equal(saved.status, "completed");
  assert.match(saved.response, /battery/);
});

test("deterministic diagnostics require selected session, owner and exact fictional notes", async () => {
  const previous = {
    mode: process.env.VOICE_DIAGNOSTIC_MODE,
    id: process.env.VOICE_DIAGNOSTIC_SESSION_ID,
    owner: process.env.VOICE_DIAGNOSTIC_USER_ID,
  };
  try {
    const a = await setup(),
      call = await a.start();
    process.env.VOICE_DIAGNOSTIC_MODE = "deterministic";
    process.env.VOICE_DIAGNOSTIC_SESSION_ID = call.session.id;
    process.env.VOICE_DIAGNOSTIC_USER_ID = a.owner;
    const bad = await a.voice.bridge(call.capability, [
      { role: "user", content: "Explain" },
    ]);
    await assert.rejects(
      a.voice.generate(bad.row, bad.turn, bad.content, () => {}),
      { status: 409 },
    );
    await a.voice.cancelTurn(a.owner, call.session.id, bad.turn.request_key);
    await pool.query(
      "UPDATE study_partner.materials SET notes=$2 WHERE id=$1",
      [a.material.id, DIAGNOSTIC_NOTES],
    );
    const turn = await a.voice.bridge(call.capability, [
      { role: "user", content: "Explain" },
      { role: "user", content: "What stores energy?" },
    ]);
    let text = "";
    await a.voice.generate(
      turn.row,
      turn.turn,
      turn.content,
      (chunk) => (text += chunk),
    );
    assert.match(text, /fictional solar cart/);
    assert.equal(
      a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
      0,
    );
    process.env.VOICE_DIAGNOSTIC_USER_ID = "not-owner";
    const next = await a.voice.bridge(call.capability, [
      { role: "user", content: "Explain" },
      { role: "user", content: "What stores energy?" },
      { role: "user", content: "Explain again" },
    ]);
    await a.voice.generate(next.row, next.turn, next.content, () => {});
    assert.equal(
      a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
      1,
    );
  } finally {
    for (const [key, value] of Object.entries({
      VOICE_DIAGNOSTIC_MODE: previous.mode,
      VOICE_DIAGNOSTIC_SESSION_ID: previous.id,
      VOICE_DIAGNOSTIC_USER_ID: previous.owner,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("uncertain provider outcomes reconcile the same turn without rebilling", async () => {
  const a = await setup(),
    call = await a.start();
  const original = a.backboard.generate.bind(a.backboard);
  a.backboard.generate = async function* (...args) {
    for await (const event of original(...args)) {
      if (event.type === "run_ended") throw new Error("Fixture transport lost");
      yield event;
    }
  };
  const messages = [{ role: "user", content: "Explain the solar cart" }];
  const first = await a.voice.bridge(call.capability, messages);
  await assert.rejects(
    a.voice.generate(first.row, first.turn, first.content, () => {}),
    { status: 503 },
  );
  assert.equal(
    (await a.study.detail(a.owner, call.session.id)).operation.status,
    "uncertain",
  );
  await assert.rejects(
    a.voice.bridge(call.capability, [
      { role: "user", content: "Changed transcript" },
    ]),
    { status: 409 },
  );
  const retry = await a.voice.bridge(call.capability, messages);
  let answer = "";
  await a.voice.generate(retry.row, retry.turn, retry.content, (text) => {
    answer += text;
  });
  assert.match(answer, /battery/);
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    1,
  );
});

test("revised interruption utterances with unchanged turn counts are distinct and retries never regenerate", async () => {
  const a = await setup(),
    call = await a.start();
  const messages = [{ role: "user", content: "What stores energy?" }];
  const first = await a.voice.bridge(call.capability, messages);
  await a.voice.generate(first.row, first.turn, first.content, () => {});
  const revision = [
    { role: "user", content: "What stores energy in the cart?" },
  ];
  const revised = await a.voice.bridge(call.capability, revision);
  assert.notEqual(revised.turn.request_key, first.turn.request_key);
  assert.equal(revised.turn.position, first.turn.position + 1);
  await a.voice.generate(revised.row, revised.turn, revised.content, () => {});
  // A delayed retry of either version is served from its own completed result.
  for (const [input, expected] of [
    [messages, first],
    [revision, revised],
  ] as const) {
    const replay = await a.voice.bridge(call.capability, input);
    assert.equal(replay.turn.request_key, expected.turn.request_key);
    let answer = "";
    await a.voice.generate(replay.row, replay.turn, replay.content, (text) => {
      answer += text;
    });
    assert.match(answer, /battery/);
  }
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    2,
  );
});

test("a new utterance waits for the previous cancellation acknowledgement", async () => {
  const a = await setup(),
    call = await a.start();
  const thread = await a.backboard.thread("fixture-assistant");
  await pool.query(
    "UPDATE study_partner.study_sessions SET thread_id=$2 WHERE id=$1",
    [call.session.id, thread],
  );
  const first = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain the cart" },
  ]);
  const reserved = await a.study.reserve(
    a.owner,
    call.session.id,
    first.turn.request_key,
    first.content,
    call.session.id,
  );
  await pool.query(
    "UPDATE study_partner.ai_operations SET run_id=$2,dispatched=true WHERE id=$1",
    [reserved.op.id, "fixture-run"],
  );
  let release!: () => void, cancelling!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    cancelling = resolve;
  });
  a.backboard.cancel = async () => {
    cancelling();
    await held;
  };
  const cancellation = a.voice.cancelTurn(
    a.owner,
    call.session.id,
    first.turn.request_key,
  );
  await entered;
  const next = await a.voice.bridge(call.capability, [
    { role: "user", content: "What powers the motor?" },
  ]);
  let answer = "";
  const running = a.voice.generate(
    next.row,
    next.turn,
    next.content,
    (text) => {
      answer += text;
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
      0,
    );
  } finally {
    release();
  }
  await cancellation;
  await running;
  assert.match(answer, /battery/);
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    1,
  );
});

test("failed reservations do not strand pending turns or release uncertain operations", async () => {
  const a = await setup(),
    call = await a.start();
  const first = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain the cart" },
  ]);
  const reserved = await a.study.reserve(
    a.owner,
    call.session.id,
    first.turn.request_key,
    first.content,
    call.session.id,
  );
  await pool.query(
    "UPDATE study_partner.ai_operations SET status='uncertain',cancel_requested=true WHERE id=$1",
    [reserved.op.id],
  );
  await pool.query(
    "UPDATE study_partner.voice_turns SET status='interrupted' WHERE session_id=$1",
    [call.session.id],
  );
  const next = await a.voice.bridge(call.capability, [
    { role: "user", content: "What powers the motor?" },
  ]);
  await assert.rejects(
    a.voice.generate(next.row, next.turn, next.content, () => {}),
    { status: 409 },
  );
  const saved = await pool.query(
    "SELECT status FROM study_partner.voice_turns WHERE request_key=$1",
    [next.turn.request_key],
  );
  assert.equal(saved.rows[0].status, "failed");
  assert.equal(
    (await a.study.operation(a.owner, call.session.id, reserved.op.id)).status,
    "uncertain",
  );
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    0,
  );
});

test("ended calls with uncertain generations explain the material block without blocking another material", async () => {
  const a = await setup(),
    call = await a.start();
  const turn = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain the cart" },
  ]);
  const { op } = await a.study.reserve(
    a.owner,
    call.session.id,
    turn.turn.request_key,
    turn.content,
    call.session.id,
  );
  await pool.query(
    "UPDATE study_partner.ai_operations SET status='uncertain',dispatched=true WHERE id=$1",
    [op.id],
  );
  await a.voice.end(a.owner, call.session.id, true);
  await assert.rejects(
    a.start(),
    /earlier AI response for this material is unresolved/,
  );
  assert.equal(
    (await a.study.operation(a.owner, call.session.id, op.id)).status,
    "uncertain",
  );
  const other = await createMaterial(pool, null, a.owner, {
    title: "Another fictional material",
    notes: fixtureNotes,
  });
  await a.study.prepare(a.owner, other.id);
  const next = await a.voice.start(a.identity, {
    id: randomUUID(),
    materialId: other.id,
    role: "Classmate",
  });
  assert.equal(next.session.materialId, other.id);
});

test("an uncertain token request cannot issue a duplicate token", async () => {
  const a = await setup();
  let requests = 0;
  a.provider.token = async () => {
    requests++;
    throw new Error("Fixture timeout");
  };
  const input = {
    id: randomUUID(),
    materialId: a.material.id,
    role: "Classmate" as const,
  };
  await assert.rejects(a.voice.start(a.identity, input), { status: 503 });
  assert.equal((await a.voice.row(input.id)).status, "uncertain");
  await assert.rejects(a.voice.start(a.identity, input), { status: 409 });
  assert.equal(requests, 1);
});
test("interruption before run_started waits for the run ID and confirms cancellation", async () => {
  const a = await setup(),
    call = await a.start();
  const turn = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain the cart" },
  ]);
  const original = a.backboard.generate.bind(a.backboard);
  a.backboard.generate = async function* (...args) {
    await a.voice.cancelTurn(a.owner, call.session.id, turn.turn.request_key);
    yield { type: "message_received" };
    yield { type: "memory_operation_created" };
    yield* original(...args);
  };
  let output = "";
  await a.voice.generate(turn.row, turn.turn, turn.content, (text) => {
    output += text;
  });
  assert.equal(output, "");
  assert.ok(a.calls.some((c) => c.path.endsWith("/cancel")));
  assert.equal(
    (await a.study.detail(a.owner, call.session.id)).operation.status,
    "cancelled",
  );
  a.backboard.generate = original;
  const next = await a.voice.bridge(call.capability, [
    { role: "user", content: "What stores energy?" },
  ]);
  await a.voice.generate(next.row, next.turn, next.content, (text) => {
    output += text;
  });
  assert.match(output, /battery/);
});

test("idle responses cannot mask an unresolved generation with reassuring filler", async () => {
  const a = await setup(),
    call = await a.start();
  const turn = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain the cart" },
  ]);
  const { op } = await a.study.reserve(
    a.owner,
    call.session.id,
    turn.turn.request_key,
    turn.content,
    call.session.id,
  );
  await pool.query(
    "UPDATE study_partner.ai_operations SET status='uncertain' WHERE id=$1",
    [op.id],
  );
  const response = await a.request(
    ["llm", "chat", "completions"],
    "POST",
    {
      model: MODEL,
      stream: true,
      messages: [
        { role: "user", content: "Explain the cart" },
        { role: "assistant", content: "Partial response" },
      ],
      elevenlabs_extra_body: { voice_capability: call.capability },
    },
    { authorization: `Bearer ${voiceConfig.ELEVENLABS_LLM_SECRET}` },
  );
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /Take your time|Let me check/);
  assert.equal(
    (await a.study.operation(a.owner, call.session.id, op.id)).status,
    "uncertain",
  );
});

test("interrupting an active voice generation cancels the Backboard run", async () => {
  const a = await setup(),
    call = await a.start();
  let release!: () => void, ready!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const original = a.backboard.generate.bind(a.backboard);
  a.backboard.generate = async function* (...args) {
    for await (const event of original(...args)) {
      yield event;
      if (event.type === "content_streaming") {
        ready();
        await pause;
      }
    }
  };
  const response = await a.request(
    ["llm", "chat", "completions"],
    "POST",
    {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "Explain the cart" }],
      elevenlabs_extra_body: { voice_capability: call.capability },
    },
    { authorization: `Bearer ${voiceConfig.ELEVENLABS_LLM_SECRET}` },
  );
  const running = response.text();
  await started;
  await a.voice.interrupt(a.owner, call.session.id);
  release();
  const body = await running;
  assert.match(body, /\[DONE\]/);
  assert.doesNotMatch(body, /voice_generation_error/);
  assert.ok(a.calls.some((c) => c.path.endsWith("/cancel")));
  const duplicate = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain the cart" },
  ]);
  assert.equal(duplicate.turn.status, "interrupted");
  a.backboard.generate = original;
  const next = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain the cart" },
    { role: "assistant", content: "Interrupted response" },
    { role: "user", content: "What stores energy?" },
  ]);
  let nextAnswer = "";
  await a.voice.generate(next.row, next.turn, next.content, (text) => {
    nextAnswer += text;
  });
  assert.match(nextAnswer, /battery/);
  await a.voice.cancelTurn(
    a.owner,
    call.session.id,
    duplicate.turn.request_key,
  );
  const completed = await a.study.operation(
    a.owner,
    call.session.id,
    (await a.study.detail(a.owner, call.session.id)).operation.id,
  );
  assert.equal(completed.status, "completed");
});
test("agent validation fails closed for recording, fallback, tools, cloned voices and overrides", async () => {
  assert.equal(readVoiceConfig({}), null);
  const a = await setup();
  await a.provider.validate();
  for (const change of [
    (agent: ReturnType<typeof agentFixture>) => {
      agent.platform_settings.privacy.record_voice = true;
    },
    (agent: ReturnType<typeof agentFixture>) => {
      agent.conversation_config.agent.prompt.backup_llm_config.preference =
        "default";
    },
    (agent: ReturnType<typeof agentFixture>) => {
      agent.conversation_config.conversation.max_duration_seconds = 601;
    },
    (agent: ReturnType<typeof agentFixture>) => {
      agent.platform_settings.overrides.conversation_config_override.agent = {
        prompt: true,
      };
    },
  ]) {
    const agent = agentFixture();
    change(agent);
    a.mock.setAgent(agent);
    await assert.rejects(a.provider.validate());
  }
  a.mock.setAgent(agentFixture());
  const cloned = new ElevenVoice(voiceConfig, async (input, init) =>
    String(input).includes("/voices/")
      ? Response.json({ category: "cloned" })
      : a.mock.transport(input, init),
  );
  await assert.rejects(cloned.validate(), { status: 503 });
});
test("consent, authorization, origin, preparation and private connection binding", async () => {
  const a = await setup(),
    b = await setup();
  assert.equal(
    (
      await a.request([], "POST", {
        id: randomUUID(),
        materialId: a.material.id,
        role: "Classmate",
      })
    ).status,
    400,
  );
  assert.equal(
    (await a.request([], "POST", {}, { origin: "https://evil.test" })).status,
    403,
  );
  const call = await a.start();
  assert.equal((await b.request([call.session.id])).status, 404);
  assert.equal(
    (await a.request([call.session.id], "GET")).headers.get("cache-control"),
    "private, no-store",
  );
  const publicBody = await (await a.request([call.session.id])).text();
  assert.doesNotMatch(publicBody, /capability|provider_id|auth_session/);
  await assert.rejects(
    a.voice.bridge(`${call.session.id}.forged`, [
      { role: "user", content: "Explain" },
    ]),
    { status: 403 },
  );
  const wrong = remoteFixture(randomUUID(), call.capability);
  a.mock.conversations.set(wrong.conversation_id, wrong);
  await assert.rejects(
    a.voice.bind(await a.voice.row(call.session.id), wrong.conversation_id),
    { status: 403 },
  );
  a.services.authenticate = async () => null;
  assert.equal((await a.request([call.session.id])).status, 401);
});
test("idle provider continuations finish without new generation and still require an active owned capability", async () => {
  const a = await setup(),
    call = await a.start();
  const headers = {
    authorization: `Bearer ${voiceConfig.ELEVENLABS_LLM_SECRET}`,
  };
  const payload = {
    model: MODEL,
    stream: true,
    messages: [
      { role: "user", content: "Explain" },
      { role: "assistant", content: "Take your time" },
    ],
    elevenlabs_extra_body: { voice_capability: call.capability },
  };
  for (let i = 0; i < 2; i++) {
    const response = await a.request(
      ["llm", "chat", "completions"],
      "POST",
      payload,
      headers,
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /\[DONE\]/);
    assert.doesNotMatch(body, /Let me check/);
    assert.match(body, /Take your time/);
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM study_partner.voice_turns WHERE session_id=$1",
        [call.session.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    0,
  );
  assert.equal(
    (
      await a.request(
        ["llm", "chat", "completions"],
        "POST",
        {
          ...payload,
          elevenlabs_extra_body: {
            voice_capability: `${call.session.id}.forged`,
          },
        },
        headers,
      )
    ).status,
    403,
  );
  assert.equal(
    (await a.request(["llm", "chat", "completions"], "POST", payload)).status,
    401,
  );
  await a.voice.end(a.owner, call.session.id);
  assert.equal(
    (await a.request(["llm", "chat", "completions"], "POST", payload, headers))
      .status,
    403,
  );
});

test("voice streaming acknowledges immediately and stays alive while model output is delayed", async () => {
  const a = await setup(),
    call = await a.start();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generate = a.voice.generate.bind(a.voice);
  a.voice.generate = async (...args) => {
    await held;
    return generate(...args);
  };
  const response = await a.request(
    ["llm", "chat", "completions"],
    "POST",
    {
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "Explain the cart" }],
      elevenlabs_extra_body: { voice_capability: call.capability },
    },
    { authorization: `Bearer ${voiceConfig.ELEVENLABS_LLM_SECRET}` },
  );
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const first = await reader.read();
    const initial = decoder.decode(first.value);
    assert.match(initial, /"role":"assistant","content":""/);
    assert.doesNotMatch(initial, /Let me check/);
    assert.equal(
      a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
      0,
    );
    const heartbeat = await reader.read();
    assert.equal(decoder.decode(heartbeat.value), ": keep-alive\n\n");
  } finally {
    release();
  }
  let output = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    output += decoder.decode(next.value);
  }
  assert.match(output, /battery/);
  assert.match(output, /\[DONE\]/);
  const detail = await a.study.detail(a.owner, call.session.id);
  assert.equal(
    detail.messages.some((m: { content: string }) =>
      m.content.includes("Let me check your material"),
    ),
    false,
  );
});

test("streaming routes the exact model, retains material memory, and deduplicates turns without replaying history", async () => {
  const a = await setup(),
    call = await a.start("Mock Examiner");
  const payload = {
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: "Explain the cart" }],
    elevenlabs_extra_body: { voice_capability: call.capability },
  };
  const headers = {
    authorization: `Bearer ${voiceConfig.ELEVENLABS_LLM_SECRET}`,
  };
  assert.equal(
    (await a.request(["llm", "chat", "completions"], "POST", payload)).status,
    401,
  );
  assert.equal(
    (
      await a.request(
        ["llm", "chat", "completions"],
        "POST",
        { ...payload, model: "other" },
        headers,
      )
    ).status,
    400,
  );
  const response = await a.request(
    ["llm", "chat", "completions"],
    "POST",
    payload,
    headers,
  );
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\[DONE\]/);
  assert.match(
    await (
      await a.request(["llm", "chat", "completions"], "POST", payload, headers)
    ).text(),
    /battery/,
  );
  const generated = a.calls.filter((c) => c.path.endsWith("/threads/messages"));
  assert.equal(generated.length, 1);
  const sent = JSON.parse(generated[0].init!.body as string);
  assert.equal(sent.model_name, MODEL);
  assert.equal(sent.llm_provider, "openrouter");
  assert.equal(sent.memory, "Auto");
  assert.equal(sent.web_search, "off");
  assert.deepEqual(sent.tools, []);
  assert.match(sent.system_prompt, /mock examiner/);
  payload.messages.push(
    { role: "assistant", content: "Earlier delivered reply" },
    { role: "user", content: "What powers the wheels?" },
  );
  await (
    await a.request(["llm", "chat", "completions"], "POST", payload, headers)
  ).text();
  const last = JSON.parse(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).at(-1)!.init!
      .body as string,
  );
  assert.doesNotMatch(last.content, /Earlier delivered reply|Explain the cart/);
  assert.match(last.content, /What powers the wheels/);
});
test("reservations, session expiry/revocation, unlimited daily starts and generation limits", async () => {
  const a = await setup(),
    call = await a.start();
  await assert.rejects(a.start(), { status: 409 });
  const textSession = await a.study.createSession(
    a.owner,
    a.material.id,
    randomUUID(),
    "study",
  );
  await assert.rejects(
    a.study.reserve(a.owner, textSession.id, randomUUID(), "Explain"),
    { status: 409 },
  );
  await pool.query(
    "UPDATE study_partner.session SET \"expiresAt\"=now()-interval '1 second' WHERE id=$1",
    [a.authId],
  );
  await assert.rejects(
    a.voice.bridge(call.capability, [{ role: "user", content: "Explain" }]),
    { status: 403 },
  );
  await a.voice.expire(a.owner);
  assert.equal((await a.voice.row(call.session.id)).status, "ending");
  const b = await setup(),
    second = await b.start();
  await pool.query(
    "UPDATE study_partner.voice_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
    [second.session.id],
  );
  await assert.rejects(
    b.voice.bridge(second.capability, [{ role: "user", content: "Explain" }]),
    { status: 403 },
  );
  await b.voice.end(b.owner, second.session.id);
  await pool.query(
    "INSERT INTO study_partner.voice_starts(id,user_id) SELECT gen_random_uuid(),$1 FROM generate_series(1,5)",
    [b.owner],
  );
  const seventh = await b.start();
  assert.equal(seventh.session.status, "starting");
  assert.equal((await b.voice.row(seventh.session.id)).status, "active");
  await assert.rejects(b.start(), { status: 409 });
  const c = await setup(),
    third = await c.start();
  await pool.query(
    "INSERT INTO study_partner.ai_usage(id,user_id) SELECT gen_random_uuid(),$1 FROM generate_series(1,10)",
    [c.owner],
  );
  const turn = await c.voice.bridge(third.capability, [
    { role: "user", content: "Explain" },
  ]);
  await assert.rejects(
    c.voice.generate(turn.row, turn.turn, turn.content, () => {}),
    { status: 429 },
  );
});
test("signed final transcripts replace live/generated text, replay is harmless, and recovery works", async () => {
  const a = await setup(),
    call = await a.start();
  const remote = { ...call.remote, status: "done" };
  const raw = JSON.stringify({ type: "post_call_transcription", data: remote });
  function signature(time = Math.floor(Date.now() / 1000)) {
    return `t=${time},v0=${createHmac("sha256", voiceConfig.ELEVENLABS_WEBHOOK_SECRET).update(`${time}.${raw}`).digest("hex")}`;
  }
  await assert.rejects(a.voice.webhook(raw, "t=0,v0=bad"), { status: 401 });
  await assert.rejects(
    a.voice.webhook(raw, signature(Math.floor(Date.now() / 1000) + 3600)),
    { status: 401 },
  );
  await a.voice.webhook(raw, signature());
  await a.voice.webhook(raw, signature());
  const saved = a.voice.public(await a.voice.row(call.session.id));
  assert.equal(saved.transcriptFinal, true);
  assert.equal(saved.transcript.length, 2);
  assert.equal(saved.status, "ended");
  await assert.rejects(
    a.voice.bridge(call.capability, [{ role: "user", content: "Again" }]),
    { status: 403 },
  );
  const second = await a.start();
  a.mock.conversations.set(second.remote.conversation_id, {
    ...second.remote,
    status: "failed",
  });
  const recovered = await a.voice.reconcile(a.owner, second.session.id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.transcriptFinal, true);
});
test("interruption, uncertain operations and deletion cleanup never blindly replay", async () => {
  const a = await setup(),
    call = await a.start();
  const args = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain" },
  ]);
  await a.voice.interrupt(a.owner, call.session.id);
  const duplicate = await a.voice.bridge(call.capability, [
    { role: "user", content: "Explain" },
  ]);
  await assert.rejects(
    a.voice.generate(
      duplicate.row,
      duplicate.turn,
      duplicate.content,
      () => {},
    ),
    { status: 409 },
  );
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    0,
  );
  assert.equal(args.turn.status, "pending");
  await a.study.reset(a.owner, a.material.id);
  await assert.rejects(a.voice.row(call.session.id), { status: 404 });
  await pool.query(
    "UPDATE study_partner.voice_cleanup SET not_before=now()-interval '1 second' WHERE alias=$1",
    [call.alias],
  );
  const remove = a.provider.remove.bind(a.provider);
  a.provider.remove = async () => {
    throw new Error("Offline");
  };
  await maintainVoice(a.voice);
  // A persistent isolated database may have earlier cleanup batches ahead of us.
  for (let batch = 0; batch < 20; batch++) {
    const job = (
      await pool.query(
        "SELECT attempts FROM study_partner.voice_cleanup WHERE alias=$1",
        [call.alias],
      )
    ).rows[0];
    if (job.attempts > 0) break;
    await maintainVoice(a.voice);
  }
  assert.ok(
    (
      await pool.query(
        "SELECT attempts FROM study_partner.voice_cleanup WHERE alias=$1",
        [call.alias],
      )
    ).rows[0].attempts > 0,
  );
  a.provider.remove = remove;
  await pool.query(
    "UPDATE study_partner.voice_cleanup SET not_before=now()-interval '1 second' WHERE alias=$1",
    [call.alias],
  );
  await maintainVoice(a.voice);
  assert.ok(a.mock.deleted.includes(call.remote.conversation_id));
  await a.study.prepare(a.owner, a.material.id);
  const second = await a.start();
  await deleteMaterial(pool, null, a.owner, a.material.id);
  await assert.rejects(a.voice.row(second.session.id), { status: 404 });
});
