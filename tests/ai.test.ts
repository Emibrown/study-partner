import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Backboard, MODEL } from "../src/lib/ai/backboard";
import {
  StudyService,
  cleanupAI,
  validateQuestions,
} from "../src/lib/ai/service";
import { studyHandler } from "../src/lib/ai/handler";
import {
  createMaterial,
  deleteMaterial,
} from "../src/lib/materials/repository";
import {
  fixtureNotes,
  mockBackboard,
  practiceFixture,
} from "./mock-backboard.mjs";
const pool = new Pool({
  connectionString:
    "postgresql://study_test@127.0.0.1:55439/study_partner_test",
});
const origin = "http://localhost:3100";
const owners: string[] = [];
async function setup() {
  const owner = randomUUID();
  owners.push(owner);
  await pool.query(
    'INSERT INTO study_partner."user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Fixture\',$2,true,now(),now())',
    [owner, `${owner}@example.test`],
  );
  const calls: { path: string; init?: RequestInit }[] = [];
  const provider = new Backboard("fictional-key", async (input, init) => {
    calls.push({ path: String(input), init });
    return mockBackboard(input, init);
  });
  const study = new StudyService(pool, provider, null);
  const material = await createMaterial(pool, null, owner, {
    title: "Fictional solar cart",
    notes: fixtureNotes,
  });
  const services = {
    study,
    origin,
    authenticate: async () => owner as string | null,
  };
  async function request(
    path: string[],
    method = "GET",
    body?: unknown,
    otherOrigin = origin,
  ) {
    return studyHandler(
      new Request(`${origin}/api/${path.join("/")}`, {
        method,
        headers: { origin: otherOrigin, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      services,
      path,
    );
  }
  async function session(kind: "study" | "practice" = "study") {
    await study.prepare(owner, material.id);
    return study.createSession(owner, material.id, randomUUID(), kind);
  }
  return {
    owner,
    provider,
    study,
    material,
    request,
    services,
    calls,
    session,
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
test("consent is required; preparation and model routing are explicit, lazy and private", async () => {
  const a = await setup();
  assert.equal(a.calls.length, 0);
  assert.equal(
    (await a.study.status(a.owner, a.material.id)).status,
    "unprepared",
  );
  assert.equal(
    (await a.request(["materials", a.material.id, "ai"], "POST", {})).status,
    400,
  );
  assert.equal(a.calls.length, 0);
  const s = await a.session();
  assert.equal((await a.study.status(a.owner, a.material.id)).status, "ready");
  const key = randomUUID();
  const response = await a.request(
    ["study-sessions", s.id, "messages"],
    "POST",
    { requestKey: key, content: "Explain the cart" },
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(await response.text(), /delta/);
  const saved = await a.study.detail(a.owner, s.id);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.operation.status, "completed");
  assert.equal(saved.thread_id, undefined);
  const payload = JSON.parse(
    a.calls.find((c) => c.path.endsWith("/threads/messages"))!.init!
      .body as string,
  );
  assert.equal(payload.llm_provider, "openrouter");
  assert.equal(payload.model_name, MODEL);
  assert.equal(payload.memory, "Auto");
  assert.equal(payload.web_search, "off");
  assert.deepEqual(payload.tools, []);
  const duplicate = await a.request(
    ["study-sessions", s.id, "messages"],
    "POST",
    { requestKey: key, content: "Explain the cart" },
  );
  assert.equal(duplicate.status, 200);
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    1,
  );
  assert.equal(
    (
      await a.request(["study-sessions", s.id, "messages"], "POST", {
        requestKey: key,
        content: "Different",
      })
    ).status,
    409,
  );
  await a.study.mode(a.owner, s.id, "Quiz");
  assert.equal((await a.study.detail(a.owner, s.id)).messages.length, 3);
});
test("ownership, origins, missing sessions and application ID validation", async () => {
  const a = await setup(),
    b = await setup();
  const s = await a.session();
  for (const action of ["", "messages", "cancel", "recover"])
    assert.equal(
      (
        await b.request(
          ["study-sessions", s.id, ...(action ? [action] : [])],
          action ? "POST" : "GET",
          action === "messages"
            ? { requestKey: randomUUID(), content: "x" }
            : undefined,
        )
      ).status,
      404,
    );
  assert.equal(
    (await b.request(["materials", a.material.id, "ai"])).status,
    404,
  );
  assert.equal(
    (await b.request(["materials", a.material.id, "ai"], "DELETE")).status,
    404,
  );
  assert.equal(
    (
      await a.request(
        ["study-sessions", s.id, "cancel"],
        "POST",
        undefined,
        "https://evil.test",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await a.request(["study-sessions", s.id, "messages"], "POST", {
        requestKey: randomUUID(),
        content: "x".repeat(8001),
      })
    ).status,
    400,
  );
  assert.equal((await a.request(["practice", s.id])).status, 404);
  a.services.authenticate = async () => null;
  assert.equal((await a.request(["study-sessions", s.id])).status, 401);
});
test("five-question validation, hidden keys, deterministic scoring and resume", async () => {
  const a = await setup();
  const s = await a.session("practice");
  const response = await a.request(["practice", s.id, "messages"], "POST", {
    requestKey: randomUUID(),
    content: "Generate practice",
  });
  assert.doesNotMatch(await response.text(), /correct|explanation|Battery/);
  const detail = await a.study.detail(a.owner, s.id);
  assert.equal(detail.questions.length, 5);
  assert.ok(
    detail.questions.every((q) => q.correct === null && q.explanation === null),
  );
  assert.equal(detail.operation.output, "");
  assert.equal(
    JSON.parse(
      a.calls.find((c) => c.path.endsWith("/threads/messages"))!.init!
        .body as string,
    ).memory,
    "off",
  );
  await assert.rejects(a.study.answer(a.owner, s.id, 2, 0), { status: 409 });
  for (let i = 0; i < 5; i++)
    await a.study.answer(a.owner, s.id, i, i === 0 ? 1 : 0);
  const recap = await a.study.detail(a.owner, s.id);
  assert.equal(recap.questions.filter((q) => q.answer === q.correct).length, 4);
  await a.study.answer(a.owner, s.id, 0, 1);
  await assert.rejects(a.study.answer(a.owner, s.id, 0, 0), { status: 409 });
  assert.equal((await a.study.history(a.owner))[0].score, 4);
  assert.throws(() => validateQuestions('{"questions":[]}'));
  const questions = practiceFixture();
  questions[0].choices = ["A", "A", "B", "C"];
  assert.throws(() => validateQuestions(JSON.stringify({ questions })));
  assert.throws(() =>
    validateQuestions(
      JSON.stringify({ questions: practiceFixture() }),
      "Unrelated material",
    ),
  );
});
test("one active generation per material, idempotency and per-user usage survive resets", async () => {
  const a = await setup();
  const s = await a.session();
  const key = randomUUID();
  const first = await a.study.reserve(a.owner, s.id, key, "Explain");
  assert.equal(
    (await a.study.reserve(a.owner, s.id, key, "Explain")).fresh,
    false,
  );
  const second = await a.study.createSession(
    a.owner,
    a.material.id,
    randomUUID(),
    "study",
  );
  await assert.rejects(
    a.study.reserve(a.owner, second.id, randomUUID(), "Explain"),
    { status: 409 },
  );
  await a.study.cancel(a.owner, s.id);
  const events: unknown[] = [];
  await a.study.run(a.owner, first.op, first.session, "Explain", (e) =>
    events.push(e),
  );
  assert.equal(
    (await a.study.detail(a.owner, s.id)).operation.status,
    "cancelled",
  );
  await pool.query(
    "INSERT INTO study_partner.ai_usage(id,user_id) SELECT gen_random_uuid(),$1 FROM generate_series(1,9)",
    [a.owner],
  );
  await assert.rejects(
    a.study.reserve(a.owner, second.id, randomUUID(), "Explain"),
    { status: 429 },
  );
  await pool.query(
    "UPDATE study_partner.ai_usage SET created_at=now()-interval '2 hours' WHERE user_id=$1",
    [a.owner],
  );
  await pool.query(
    "INSERT INTO study_partner.ai_usage(id,user_id,created_at) SELECT gen_random_uuid(),$1,now()-interval '2 hours' FROM generate_series(1,90)",
    [a.owner],
  );
  await assert.rejects(
    a.study.reserve(a.owner, second.id, randomUUID(), "Explain"),
    { status: 429 },
  );
  await a.study.reset(a.owner, a.material.id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM study_partner.ai_usage WHERE user_id=$1",
        [a.owner],
      )
    ).rows[0].n,
    100,
  );
});
test("uncertain streams reconcile without a second billable request", async () => {
  const a = await setup();
  const s = await a.session();
  const original = a.provider.generate.bind(a.provider);
  a.provider.generate = async function* (...args) {
    for await (const event of original(...args)) {
      if (event.type === "run_ended") throw new Error("Connection lost");
      yield event;
    }
  };
  const reserved = await a.study.reserve(
    a.owner,
    s.id,
    randomUUID(),
    "Explain",
  );
  await a.study.run(
    a.owner,
    reserved.op,
    reserved.session,
    "Explain",
    () => {},
  );
  assert.equal(
    (await a.study.detail(a.owner, s.id)).operation.status,
    "uncertain",
  );
  const recovered = await a.study.recover(a.owner, s.id);
  assert.equal(recovered.operation.status, "completed");
  assert.equal(
    recovered.messages.filter((m) => m.role === "assistant").length,
    1,
  );
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    1,
  );
});
test("indexing failure, unavailable provider and deletion/reset cleanup retry", async () => {
  const a = await setup();
  a.provider.status = async () => "error";
  assert.equal(
    (await a.study.prepare(a.owner, a.material.id)).status,
    "failed",
  );
  await assert.rejects(
    a.study.createSession(a.owner, a.material.id, randomUUID(), "study"),
    { status: 409 },
  );
  await a.study.reset(a.owner, a.material.id);
  assert.equal(
    (await a.study.status(a.owner, a.material.id)).status,
    "unprepared",
  );
  a.provider.status = async () => "indexed";
  const s = await a.session();
  await deleteMaterial(pool, null, a.owner, a.material.id);
  await assert.rejects(a.study.detail(a.owner, s.id), { status: 404 });
  await pool.query(
    "UPDATE study_partner.ai_cleanup SET not_before=now()-interval '1 minute'",
  );
  const cleanup = a.provider.cleanup.bind(a.provider);
  a.provider.cleanup = async () => {
    throw new Error("Offline");
  };
  await cleanupAI(pool, a.provider);
  assert.ok(
    (
      await pool.query(
        "SELECT 1 FROM study_partner.ai_cleanup WHERE attempts>0",
      )
    ).rowCount,
  );
  a.provider.cleanup = cleanup;
  await pool.query(
    "UPDATE study_partner.ai_cleanup SET not_before=now()-interval '1 minute'",
  );
  await cleanupAI(pool, a.provider);
  a.study.provider = null;
  await assert.rejects(a.study.prepare(a.owner, a.material.id), {
    status: 503,
  });
});
test("stream cancellation persists partial text and prevents concurrent sends", async () => {
  const a = await setup();
  const s = await a.session();
  const reserved = await a.study.reserve(
    a.owner,
    s.id,
    randomUUID(),
    "Explain",
  );
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = a.provider.generate.bind(a.provider);
  a.provider.generate = async function* (...args) {
    for await (const event of original(...args)) {
      yield event;
      if (event.type === "content_streaming") {
        started();
        await pause;
      }
    }
  };
  const running = a.study.run(
    a.owner,
    reserved.op,
    reserved.session,
    "Explain",
    () => {},
  );
  await ready;
  await assert.rejects(a.study.reserve(a.owner, s.id, randomUUID(), "Other"), {
    status: 409,
  });
  await a.study.cancel(a.owner, s.id);
  release();
  await running;
  const detail = await a.study.detail(a.owner, s.id);
  assert.equal(detail.operation.status, "cancelled");
  assert.equal(detail.messages.filter((m) => m.role === "assistant").length, 1);
  assert.ok(a.calls.some((c) => c.path.endsWith("/cancel")));
});
test("provider outages fail closed and expired operation leases never replay", async () => {
  const a = await setup();
  const s = await a.session();
  const reserved = await a.study.reserve(
    a.owner,
    s.id,
    randomUUID(),
    "Explain",
  );
  await pool.query(
    "UPDATE study_partner.ai_operations SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [reserved.op.id],
  );
  const detail = await a.study.recover(a.owner, s.id);
  assert.equal(detail.operation.status, "uncertain");
  assert.equal(
    a.calls.filter((c) => c.path.endsWith("/threads/messages")).length,
    0,
  );
  await assert.rejects(a.study.reserve(a.owner, s.id, randomUUID(), "Retry"), {
    status: 409,
  });
  const b = await setup();
  b.provider.assistant = async () => {
    throw new Error("Network down");
  };
  await assert.rejects(b.study.prepare(b.owner, b.material.id), {
    status: 503,
  });
  assert.equal(
    (await b.study.status(b.owner, b.material.id)).status,
    "uncertain",
  );
});
test("assistant isolation, preparation idempotency, and pending indexing", async () => {
  const a = await setup();
  a.provider.status = async () => "processing";
  assert.equal(
    (await a.study.prepare(a.owner, a.material.id)).status,
    "indexing",
  );
  await a.study.prepare(a.owner, a.material.id);
  assert.equal(
    a.calls.filter(
      (c) => c.path.endsWith("/assistants") && c.init?.method === "POST",
    ).length,
    1,
  );
  await assert.rejects(
    a.study.createSession(a.owner, a.material.id, randomUUID(), "study"),
    { status: 409 },
  );
  const other = await createMaterial(pool, null, a.owner, {
    title: "Different notes",
    notes: "Another subject.",
  });
  await a.study.prepare(a.owner, other.id);
  const contexts = await pool.query(
    "SELECT assistant_id FROM study_partner.material_ai WHERE material_id=ANY($1::uuid[])",
    [[a.material.id, other.id]],
  );
  assert.equal(new Set(contexts.rows.map((c) => c.assistant_id)).size, 2);
});
test("PDF preparation uploads owned bytes only after consent", async () => {
  const a = await setup();
  const bytes = new TextEncoder().encode("%PDF-1.7\nfictional fixture\n%%EOF");
  const objects = new Map<string, Uint8Array>();
  a.study.storage = {
    async put(key, value) {
      objects.set(key, value);
    },
    async get(key) {
      return objects.get(key)!;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const material = await createMaterial(pool, a.study.storage, a.owner, {
    title: "Fictional PDF",
    pdf: bytes,
  });
  assert.equal(a.calls.length, 0);
  await a.study.prepare(a.owner, material.id);
  const upload = a.calls.find(
    (c) => c.path.endsWith("/documents") && c.init?.method === "POST",
  )!;
  const file = (upload.init!.body as FormData).get("file") as File;
  assert.equal(file.name, "material.pdf");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
});
test("invalid generated practice fails without exposing raw answer data", async () => {
  const a = await setup();
  const s = await a.session("practice");
  a.provider.generate = async function* () {
    yield { type: "content_streaming", content: '{"questions":[]}' };
    yield { type: "run_ended", status: "COMPLETED" };
  };
  const response = await a.request(["practice", s.id, "messages"], "POST", {
    requestKey: randomUUID(),
    content: "Generate",
  });
  assert.match(await response.text(), /Five supported questions/);
  const detail = await a.study.detail(a.owner, s.id);
  assert.equal(detail.questions.length, 0);
  assert.equal(detail.operation.status, "failed");
  assert.equal(detail.operation.output, "");
});
