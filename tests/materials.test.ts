import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  materialHandler,
  boundedBody,
  type MaterialServices,
} from "../src/lib/materials/handler";
import {
  createMaterial,
  cleanupMaterials,
} from "../src/lib/materials/repository";
import { readProfile } from "../src/lib/auth/preferences";
import { defaultPreferences } from "../src/lib/fixtures";
import { MAX_PDF_BYTES } from "../src/lib/materials/types";
import {
  createStorage,
  type ObjectStorage,
} from "../src/lib/materials/storage";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
const pool = new Pool({
  connectionString:
    "postgresql://study_test@127.0.0.1:55439/study_partner_test",
});
const owners: string[] = [];
const origin = "http://localhost:3100";
const pdf = Buffer.from("%PDF-1.7\nfictional test document\n%%EOF");
test("R2 adapter uses private SDK commands and handles missing configuration", async (t) => {
  assert.equal(createStorage({}), null);
  const commands: unknown[] = [];
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    commands.push(command);
    return command instanceof GetObjectCommand
      ? { Body: { transformToByteArray: async () => pdf } }
      : {};
  });
  const storage = createStorage({
    R2_ENDPOINT: "https://fixture.r2.cloudflarestorage.com",
    R2_BUCKET: "private-test",
    R2_ACCESS_KEY_ID: "test",
    R2_SECRET_ACCESS_KEY: "test",
  })!;
  await storage.put("private/random.pdf", pdf);
  assert.deepEqual(await storage.get("private/random.pdf"), pdf);
  await storage.delete("private/random.pdf");
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.equal(commands[0].input.Bucket, "private-test");
  assert.equal(commands[0].input.ACL, undefined);
  assert.ok(commands[2] instanceof DeleteObjectCommand);
});
async function setup() {
  const owner = randomUUID();
  owners.push(owner);
  await pool.query(
    'INSERT INTO study_partner."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())',
    [owner, "Fixture User", `${owner}@example.test`],
  );
  const objects = new Map<string, Uint8Array>();
  const storage: ObjectStorage = {
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) throw new Error("Missing");
      return body;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const services: MaterialServices = {
    pool,
    storage,
    origin,
    authenticate: async () => owner,
  };
  function request(
    method: string,
    body?: unknown,
    id?: string,
    content = false,
    headers: Record<string, string> = {},
  ) {
    return materialHandler(
      new Request(origin + "/api/materials", {
        method,
        headers: {
          origin,
          ...(body instanceof Uint8Array
            ? {
                "content-type": "application/pdf",
                "x-material-title": "My%20PDF",
              }
            : { "content-type": "application/json" }),
          ...headers,
        },
        body:
          body === undefined
            ? undefined
            : body instanceof Uint8Array
              ? new Uint8Array(body)
              : JSON.stringify(body),
      }),
      services,
      id,
      content,
    );
  }
  return { owner, objects, storage, services, request };
}
after(async () => {
  for (const owner of owners) {
    await pool.query("DELETE FROM study_partner.materials WHERE user_id = $1", [
      owner,
    ]);
    await pool.query('DELETE FROM study_partner."user" WHERE id = $1', [owner]);
  }
  await pool.end();
});
test("private notes persist, preserve text, reject another owner, and delete", async () => {
  const a = await setup();
  const b = await setup();
  const text = "<script>alert(1)</script>\n  My own notes  ";
  const created = await a.request("POST", {
    title: "  Lecture  ",
    notes: text,
  });
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.equal(item.title, "Lecture");
  assert.equal(item.notes, text);
  assert.equal((await (await a.request("GET")).json()).materials.length, 1);
  assert.equal((await a.request("GET", undefined, item.id)).status, 200);
  const download = await a.request("GET", undefined, item.id, true);
  assert.equal(await download.text(), text);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  for (const method of ["GET", "DELETE"])
    assert.equal((await b.request(method, undefined, item.id)).status, 404);
  assert.equal((await b.request("GET", undefined, item.id, true)).status, 404);
  assert.equal(
    (await a.request("GET", undefined, "materials/guess.pdf", true)).status,
    404,
  );
  assert.equal((await a.request("DELETE", undefined, item.id)).status, 200);
  assert.equal((await a.request("GET", undefined, item.id)).status, 404);
});
test("PDF upload/download uses private random keys and queues failed deletion", async () => {
  const a = await setup();
  const response = await a.request("POST", pdf);
  assert.equal(response.status, 201);
  const item = await response.json();
  assert.equal(item.object_key, undefined);
  assert.equal(a.objects.size, 1);
  assert.ok(![...a.objects.keys()][0].includes(a.owner));
  const download = await a.request("GET", undefined, item.id, true);
  assert.equal(download.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
  const remove = a.storage.delete;
  a.storage.delete = async () => {
    throw new Error("Offline");
  };
  const result = await (await a.request("DELETE", undefined, item.id)).json();
  assert.equal(result.cleanupPending, true);
  assert.equal((await a.request("GET", undefined, item.id)).status, 404);
  assert.equal(
    (
      await pool.query(
        "SELECT cleanup_attempts FROM study_partner.materials WHERE id=$1",
        [item.id],
      )
    ).rows[0].cleanup_attempts,
    1,
  );
  a.storage.delete = remove;
  await cleanupMaterials(pool, a.storage, a.owner);
  assert.equal(a.objects.size, 0);
});
test("failed upload cleanup, stale reservations, and storage errors are recoverable", async () => {
  const a = await setup();
  a.storage.put = async (key, bytes) => {
    a.objects.set(key, bytes);
    throw new Error("Response lost");
  };
  assert.equal((await a.request("POST", pdf)).status, 503);
  assert.equal(a.objects.size, 1);
  await cleanupMaterials(pool, a.storage, a.owner);
  assert.equal(a.objects.size, 1);
  await pool.query(
    "UPDATE study_partner.materials SET updated_at = now() - interval '2 hours' WHERE user_id = $1",
    [a.owner],
  );
  await cleanupMaterials(pool, a.storage, a.owner);
  assert.equal(a.objects.size, 0);
  assert.equal((await (await a.request("GET")).json()).materials.length, 0);
  const id = randomUUID();
  const key = `materials/${id}.pdf`;
  a.objects.set(key, pdf);
  await pool.query(
    "INSERT INTO study_partner.materials (id,user_id,title,kind,object_key,byte_size,state,updated_at) VALUES ($1,$2,'Interrupted','PDF',$3,100,'uploading',now()-interval '2 hours')",
    [id, a.owner, key],
  );
  await cleanupMaterials(pool, a.storage, a.owner);
  assert.equal(a.objects.size, 0);
  a.services.storage = null;
  assert.equal((await a.request("POST", pdf)).status, 503);
  assert.equal(
    (await a.request("POST", { title: "Notes", notes: "Still available" }))
      .status,
    201,
  );
});
test("validation, authentication, origin and database rate limits", async () => {
  const a = await setup();
  assert.equal(
    (await a.request("POST", { title: "", notes: "x" })).status,
    400,
  );
  assert.equal(
    (await a.request("POST", { title: "x", notes: " " })).status,
    400,
  );
  assert.equal(
    (await a.request("POST", { title: "x", notes: "x".repeat(100001) })).status,
    400,
  );
  assert.equal(
    (await a.request("POST", { title: "x", notes: "x", userId: "other" }))
      .status,
    400,
  );
  assert.equal((await a.request("POST", Buffer.from("not a PDF"))).status, 400);
  assert.equal(
    (
      await a.request("POST", pdf, undefined, false, {
        "content-type": "image/png",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await a.request("POST", pdf, undefined, false, {
        "content-length": String(MAX_PDF_BYTES + 1),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await a.request("POST", {}, undefined, false, {
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  for (let i = 0; i < 4; i++) await a.request("POST", {});
  assert.equal((await a.request("POST", {})).status, 429);
  a.services.authenticate = async () => null;
  assert.equal((await a.request("GET")).status, 401);
  assert.equal((await a.request("POST", {})).status, 401);
});
test("actual streamed bytes enforce the limit without Content-Length", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  const request = new Request(origin, {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(boundedBody(request, 10), { status: 413 });
});
test("concurrent reservations enforce count and byte quotas", async () => {
  const a = await setup();
  for (let i = 0; i < 99; i++)
    await createMaterial(pool, null, a.owner, { title: "Fixture", notes: "x" });
  const results = await Promise.allSettled([
    createMaterial(pool, null, a.owner, { title: "A", notes: "a" }),
    createMaterial(pool, null, a.owner, { title: "B", notes: "b" }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const b = await setup();
  for (let i = 0; i < 25; i++)
    await pool.query(
      "INSERT INTO study_partner.materials (id,user_id,title,kind,object_key,byte_size,state) VALUES ($1,$2,'Fixture','PDF',$3,$4,'uploading')",
      [randomUUID(), b.owner, randomUUID(), MAX_PDF_BYTES],
    );
  await assert.rejects(
    createMaterial(pool, b.storage, b.owner, { title: "Too much", pdf }),
    { status: 409 },
  );
});
test("existing preference subject is ignored without losing completion", async () => {
  const a = await setup();
  await pool.query(
    "INSERT INTO study_partner.user_preferences(user_id,preferences,onboarding_completed_at) VALUES ($1,$2,now())",
    [a.owner, JSON.stringify({ ...defaultPreferences, subject: "Biology" })],
  );
  const profile = await readProfile(pool, a.owner);
  assert.equal(profile.onboarded, true);
  assert.deepEqual(profile.preferences, defaultPreferences);
});
