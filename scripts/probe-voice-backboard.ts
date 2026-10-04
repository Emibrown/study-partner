import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Backboard } from "../src/lib/ai/backboard";
import { databaseConnectionString } from "../src/lib/auth/database";

// Explicit opt-in: one fictional generation, with durable cleanup before creation.
async function main() {
  if (!process.argv.includes("--live")) throw new Error("live opt-in required");
  loadEnvConfig(".", false, { info() {}, error() {} });
  if (!process.env.BACKBOARD_API_KEY || !process.env.DATABASE_URL)
    throw new Error();
  const db = new Pool({
    connectionString: databaseConnectionString(process.env.DATABASE_URL),
  });
  const provider = new Backboard(process.env.BACKBOARD_API_KEY);
  const context = randomUUID();
  let assistant: string | null = null;
  let stage = "cleanup_reservation";
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  try {
    await db.query(
      "INSERT INTO study_partner.ai_cleanup(context_id) VALUES($1)",
      [context],
    );
    stage = "assistant_creation";
    assistant = await provider.assistant(context);
    await db.query(
      "UPDATE study_partner.ai_cleanup SET assistant_id=$2 WHERE context_id=$1",
      [context, assistant],
    );
    stage = "document_upload";
    const document = await provider.document(
      assistant,
      new TextEncoder().encode(
        "Fictional study note: A solar cart uses a panel to charge a battery. The battery stores energy and powers a small motor.",
      ),
      false,
    );
    stage = "document_indexing";
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const status = (await provider.status(document)).toLowerCase();
      if (["indexed", "completed", "ready"].includes(status)) {
        ready = true;
        break;
      }
      if (status === "failed") throw new Error();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error();
    stage = "thread_creation";
    const thread = await provider.thread(assistant);
    console.log(JSON.stringify({ event: "probe_ready", elapsedMs: elapsed() }));
    stage = "generation";
    const generation = performance.now();
    let first = false;
    let completed = false;
    for await (const event of provider.generate(
      thread,
      "What stores energy in the fictional solar cart?",
      "Answer in one short sentence from the provided note.",
      false,
    )) {
      if (event.type === "run_ended") completed = event.status === "COMPLETED";
      if (event.type === "content_streaming") {
        if (!first)
          console.log(
            JSON.stringify({
              event: "first_token",
              elapsedMs: Math.round(performance.now() - generation),
            }),
          );
        first = true;
      } else {
        console.log(
          JSON.stringify({
            event: /^[a-z_]{1,40}$/.test(event.type) ? event.type : "other",
            status:
              event.status && /^[a-zA-Z_]{1,30}$/.test(event.status)
                ? event.status
                : undefined,
            elapsedMs: Math.round(performance.now() - generation),
          }),
        );
      }
    }
    if (!first || !completed) throw new Error();
    console.log(
      JSON.stringify({
        event: "probe_finished",
        receivedText: first,
        completed,
        elapsedMs: elapsed(),
      }),
    );
  } catch {
    console.log(
      JSON.stringify({ event: "probe_failed", stage, elapsedMs: elapsed() }),
    );
    throw new Error();
  } finally {
    try {
      await provider.cleanup(context, assistant);
      await db.query(
        "DELETE FROM study_partner.ai_cleanup WHERE context_id=$1",
        [context],
      );
      console.log(JSON.stringify({ event: "probe_cleanup_completed" }));
    } catch {
      console.log(JSON.stringify({ event: "probe_cleanup_queued" }));
    }
    await db.end();
  }
}
main().catch(() => {
  console.error("Fictional provider probe failed; no private payload logged.");
  process.exitCode = 1;
});
