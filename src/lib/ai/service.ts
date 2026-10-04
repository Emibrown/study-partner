import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getMaterial, MaterialError } from "../materials/repository";
import type { ObjectStorage } from "../materials/storage";
import { Backboard, ProviderError } from "./backboard";
import type { StudyMode } from "./types";

type Context = {
  material_id: string;
  context_id: string;
  assistant_id: string | null;
  document_id: string | null;
  status: string;
  lease_until: Date;
};
type SessionRow = {
  id: string;
  material_id: string;
  kind: "study" | "practice" | "voice";
  mode: string;
  thread_id: string | null;
  title: string;
  created_at: Date;
  updated_at: Date;
};
type Op = {
  id: string;
  session_id: string;
  material_id: string;
  status: string;
  output: string;
  fingerprint: string;
  run_id: string | null;
  provider_message_id: string | null;
  baseline_ids: string[];
  cancel_requested: boolean;
  dispatched: boolean;
  lease_until: Date;
};
const uuid = z.uuid();
const failure = (status: number, message: string): never => {
  throw new MaterialError(status, message);
};
export const questionSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            question: z.string().trim().min(5).max(2000),
            choices: z
              .array(z.string().trim().min(1).max(1000))
              .length(4)
              .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === 4),
            correct: z.number().int().min(0).max(3),
            explanation: z.string().trim().min(5).max(3000),
            topic: z.string().trim().min(1).max(150),
            evidence: z.string().trim().min(5).max(3000),
          })
          .strict(),
      )
      .length(5)
      .refine(
        (v) => new Set(v.map((x) => x.question.toLowerCase())).size === 5,
      ),
  })
  .strict();
export function validateQuestions(content: string, notes?: string | null) {
  const parsed = questionSchema.parse(JSON.parse(content));
  const normalize = (text: string) =>
    text.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    notes &&
    parsed.questions.some(
      (q) => !normalize(notes).includes(normalize(q.evidence)),
    )
  )
    throw new Error("Unsupported evidence");
  return parsed.questions;
}
const practicePrompt =
  'Create exactly five supported multiple-choice questions from the attached material. Return ONLY JSON {"questions":[{"question":"...","choices":["...","...","...","..."],"correct":0,"explanation":"...","topic":"...","evidence":"exact verbatim quotation from the material"}]}. correct is a zero-based index. Four distinct choices, one unambiguously correct answer. Do not put answers in question text. If insufficient material exists return {"questions":[]} instead of inventing facts. No markdown fences.';
const instructions: Record<string, string> = {
  Explain:
    "Explain the learner's question using the material. Ask a clarifying question when needed.",
  Quiz: "Ask only one conversational question at a time based on the material. Evaluate the previous answer before the next question. Do not reveal the answer before the learner tries.",
  "Explain It Back":
    "Invite the learner to explain a concept, then give supportive, specific feedback on accuracy and gaps against the material.",
};

export class StudyService {
  constructor(
    public pool: Pool,
    public provider: Backboard | null,
    public storage: ObjectStorage | null,
  ) {}
  providerRequired() {
    return (
      this.provider ??
      failure(
        503,
        "AI study is not configured yet. Your material is still available to read.",
      )
    );
  }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async context(owner: string, material: string) {
    await getMaterial(this.pool, owner, material);
    return (
      await this.pool.query<Context>(
        "SELECT * FROM study_partner.material_ai WHERE material_id=$1",
        [material],
      )
    ).rows[0];
  }
  async status(owner: string, material: string) {
    let ctx = await this.context(owner, material);
    if (ctx?.status === "indexing" && ctx.document_id && this.provider) {
      const remote = await this.provider.status(ctx.document_id);
      const status =
        remote === "indexed"
          ? "ready"
          : ["error", "failed"].includes(remote)
            ? "failed"
            : "indexing";
      await this.pool.query(
        "UPDATE study_partner.material_ai SET status=$2 WHERE material_id=$1 AND context_id=$3 AND status='indexing'",
        [material, status, ctx.context_id],
      );
      ctx = await this.context(owner, material);
    }
    if (ctx?.status === "preparing" && ctx.lease_until < new Date()) {
      await this.pool.query(
        "UPDATE study_partner.material_ai SET status='uncertain' WHERE material_id=$1 AND status='preparing' AND lease_until < now()",
        [material],
      );
      ctx.status = "uncertain";
    }
    return {
      status: ctx?.status ?? "unprepared",
      configured: Boolean(this.provider),
    };
  }
  async prepare(owner: string, material: string) {
    const provider = this.providerRequired();
    const source = await getMaterial(this.pool, owner, material);
    if (source.key && !this.storage)
      failure(503, "PDF storage is unavailable. Please try later.");
    const context = randomUUID();
    const claimed = await this.pool.query(
      "INSERT INTO study_partner.material_ai(material_id,context_id,status) SELECT id,$3,'preparing' FROM study_partner.materials WHERE id=$1 AND user_id=$2 AND state='ready' ON CONFLICT DO NOTHING RETURNING material_id",
      [material, owner, context],
    );
    if (!claimed.rowCount) return this.status(owner, material);
    try {
      const assistant = await provider.assistant(context);
      const saved = await this.pool.query(
        "UPDATE study_partner.material_ai SET assistant_id=$2 WHERE material_id=$1 AND context_id=$3 RETURNING material_id",
        [material, assistant, context],
      );
      if (!saved.rowCount) {
        await this.pool.query(
          "UPDATE study_partner.ai_cleanup SET assistant_id=$2 WHERE context_id=$1",
          [context, assistant],
        );
        return failure(409, "This material's AI data was reset.");
      }
      const bytes = source.key
        ? await this.storage!.get(source.key)
        : new TextEncoder().encode(source.detail.notes!);
      const document = await provider.document(
        assistant,
        bytes,
        Boolean(source.key),
      );
      await this.pool.query(
        "UPDATE study_partner.material_ai SET document_id=$2,status='indexing' WHERE material_id=$1 AND context_id=$3",
        [material, document, context],
      );
    } catch (error) {
      await this.pool.query(
        "UPDATE study_partner.material_ai SET status=$2 WHERE material_id=$1 AND context_id=$3",
        [
          material,
          error instanceof ProviderError && error.definite
            ? "failed"
            : "uncertain",
          context,
        ],
      );
      failure(
        503,
        "Preparation could not finish. Check status, or reset AI data before trying again.",
      );
    }
    return this.status(owner, material);
  }
  async reset(owner: string, material: string) {
    await this.transaction(async (db) => {
      const result = await db.query(
        "SELECT id FROM study_partner.materials WHERE id=$1 AND user_id=$2 AND state='ready' FOR UPDATE",
        [uuid.parse(material), owner],
      );
      if (!result.rowCount) failure(404, "Material not found.");
      await db.query(
        "DELETE FROM study_partner.material_ai WHERE material_id=$1",
        [material],
      );
    });
  }
  async session(owner: string, session: string): Promise<SessionRow> {
    if (!uuid.safeParse(session).success) failure(404, "Session not found.");
    const result = await this.pool.query<SessionRow>(
      "SELECT s.*,m.title FROM study_partner.study_sessions s JOIN study_partner.materials m ON m.id=s.material_id WHERE s.id=$1 AND m.user_id=$2 AND m.state='ready'",
      [session, owner],
    );
    return result.rows[0] ?? failure(404, "Session not found.");
  }
  async createSession(
    owner: string,
    material: string,
    sessionId: string,
    kind: "study" | "practice",
    mode: StudyMode = "Explain",
  ) {
    const ctx = await this.context(owner, material);
    if (ctx?.status !== "ready")
      failure(409, "Prepare this material for AI study first.");
    await this.pool.query(
      "INSERT INTO study_partner.study_sessions(id,material_id,kind,mode) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [sessionId, material, kind, kind === "practice" ? "Practice" : mode],
    );
    const session = await this.session(owner, sessionId);
    if (session.material_id !== material || session.kind !== kind)
      failure(409, "This request ID has already been used.");
    return this.detail(owner, session.id);
  }
  async detail(owner: string, id: string) {
    const s = await this.session(owner, id);
    const messages = (
      await this.pool.query(
        "SELECT id,role,content,created_at FROM study_partner.study_messages WHERE session_id=$1 ORDER BY created_at,id",
        [id],
      )
    ).rows;
    const operation = (
      await this.pool.query(
        "SELECT id,status,output FROM study_partner.ai_operations WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    if (operation && s.kind === "practice") operation.output = "";
    const questions = (
      await this.pool.query(
        "SELECT position,question,choices,answer,CASE WHEN answer IS NOT NULL THEN correct END AS correct,CASE WHEN answer IS NOT NULL THEN explanation END AS explanation,CASE WHEN answer IS NOT NULL THEN topic END AS topic FROM study_partner.practice_questions WHERE session_id=$1 ORDER BY position",
        [id],
      )
    ).rows;
    return {
      id: s.id,
      material_id: s.material_id,
      title: s.title,
      kind: s.kind,
      mode: s.mode,
      created_at: s.created_at,
      updated_at: s.updated_at,
      messages,
      operation,
      questions,
    };
  }
  async history(owner: string, material?: string) {
    if (material) await getMaterial(this.pool, owner, material);
    return (
      await this.pool.query(
        "SELECT s.id,s.material_id,s.kind,s.mode,s.created_at,s.updated_at,m.title,(SELECT CASE WHEN interrupted OR status='failed' THEN 'interrupted' ELSE status END FROM study_partner.voice_sessions v WHERE v.id=s.id) AS voice_status,(SELECT count(*)::int FROM study_partner.practice_questions q WHERE q.session_id=s.id AND answer IS NOT NULL) AS answered,(SELECT count(*)::int FROM study_partner.practice_questions q WHERE q.session_id=s.id AND answer=correct) AS score FROM study_partner.study_sessions s JOIN study_partner.materials m ON m.id=s.material_id WHERE m.user_id=$1 AND m.state='ready' AND ($2::uuid IS NULL OR m.id=$2) ORDER BY s.updated_at DESC LIMIT 100",
        [owner, material ?? null],
      )
    ).rows;
  }
  async mode(owner: string, id: string, mode: StudyMode) {
    const s = await this.session(owner, id);
    if (s.kind !== "study") failure(400, "Practice mode cannot be changed.");
    await this.transaction(async (db) => {
      await db.query(
        "UPDATE study_partner.study_sessions SET mode=$2,updated_at=now() WHERE id=$1",
        [id, mode],
      );
      await db.query(
        "INSERT INTO study_partner.study_messages(id,session_id,role,content) VALUES($1,$2,'mode',$3)",
        [randomUUID(), id, mode],
      );
    });
    return this.detail(owner, id);
  }
  async reserve(
    owner: string,
    id: string,
    key: string,
    content: string,
    voiceSessionId?: string,
  ) {
    this.providerRequired();
    const s = await this.session(owner, id);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([id, content]))
      .digest("hex");
    return this.transaction(async (db) => {
      await db.query(
        'SELECT id FROM study_partner."user" WHERE id=$1 FOR UPDATE',
        [owner],
      );
      const prior = (
        await db.query<Op>(
          "SELECT * FROM study_partner.ai_operations WHERE user_id=$1 AND request_key=$2",
          [owner, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          failure(409, "This request ID belongs to another message.");
        return { op: prior, fresh: false, session: s };
      }
      const ctx = (
        await db.query<Context>(
          "SELECT * FROM study_partner.material_ai WHERE material_id=$1 FOR UPDATE",
          [s.material_id],
        )
      ).rows[0];
      if (ctx?.status !== "ready")
        failure(409, "Material is not ready for AI study.");
      const voice = await db.query(
        "SELECT id FROM study_partner.voice_sessions WHERE material_id=$1 AND status IN ('starting','active','uncertain') AND expires_at>now()",
        [s.material_id],
      );
      if (s.kind === "voice") {
        if (voiceSessionId !== id || !voice.rows.some((row) => row.id === id))
          failure(403, "This voice session is no longer active.");
      } else if (voice.rowCount)
        failure(
          409,
          "End the active voice session before generating for this material.",
        );
      const busy = await db.query(
        "SELECT id FROM study_partner.ai_operations WHERE material_id=$1 AND status IN ('running','uncertain')",
        [s.material_id],
      );
      if (busy.rowCount)
        failure(
          409,
          "A request for this material is still active or needs recovery. Open its session before sending again.",
        );
      if (
        s.kind === "practice" &&
        (
          await db.query(
            "SELECT 1 FROM study_partner.practice_questions WHERE session_id=$1",
            [id],
          )
        ).rowCount
      )
        failure(409, "This practice is already ready.");
      const usage = (
        await db.query(
          "SELECT count(*) FILTER (WHERE created_at>now()-interval '1 minute')::int AS minute,count(*)::int AS day FROM study_partner.ai_usage WHERE user_id=$1 AND created_at>now()-interval '24 hours'",
          [owner],
        )
      ).rows[0];
      if (usage.minute >= 10 || usage.day >= 100)
        failure(
          429,
          usage.day >= 100
            ? "Daily AI limit reached. Please try tomorrow."
            : "Please wait a minute before generating again.",
        );
      const op = (
        await db.query<Op>(
          "INSERT INTO study_partner.ai_operations(id,user_id,material_id,session_id,request_key,fingerprint,status) VALUES($1,$2,$3,$4,$5,$6,'running') RETURNING *",
          [randomUUID(), owner, s.material_id, id, key, fingerprint],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO study_partner.ai_usage(id,user_id) VALUES($1,$2)",
        [op.id, owner],
      );
      if (s.kind !== "practice")
        await db.query(
          "INSERT INTO study_partner.study_messages(id,session_id,role,content) VALUES($1,$2,'user',$3)",
          [randomUUID(), id, content],
        );
      return { op, fresh: true, session: s };
    });
  }
  async finish(owner: string, op: Op, output: string, cancelled = false) {
    const s = await this.session(owner, op.session_id);
    const source = await getMaterial(this.pool, owner, s.material_id);
    let questions: ReturnType<typeof validateQuestions> = [];
    if (s.kind === "practice" && !cancelled) {
      try {
        questions = validateQuestions(output, source.detail.notes);
      } catch {
        await this.pool.query(
          "UPDATE study_partner.ai_operations SET status='failed',output='' WHERE id=$1",
          [op.id],
        );
        failure(
          422,
          "Five supported questions could not be produced. Try again or add more detailed material.",
        );
      }
    }
    await this.transaction(async (db) => {
      const locked = (
        await db.query<Op>(
          "SELECT * FROM study_partner.ai_operations WHERE id=$1 FOR UPDATE",
          [op.id],
        )
      ).rows[0];
      if (!locked || !["running", "uncertain"].includes(locked.status)) return;
      if (s.kind !== "practice" && output)
        await db.query(
          "INSERT INTO study_partner.study_messages(id,session_id,role,content) VALUES($1,$2,'assistant',$3)",
          [randomUUID(), s.id, output],
        );
      for (const [position, q] of questions.entries())
        await db.query(
          "INSERT INTO study_partner.practice_questions(session_id,position,question,choices,correct,explanation,topic,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            s.id,
            position,
            q.question,
            JSON.stringify(q.choices),
            q.correct,
            q.explanation,
            q.topic,
            q.evidence,
          ],
        );
      await db.query(
        "UPDATE study_partner.ai_operations SET status=$2,output=$3 WHERE id=$1",
        [
          op.id,
          cancelled || locked.cancel_requested ? "cancelled" : "completed",
          s.kind === "voice" ? output : "",
        ],
      );
      await db.query(
        "UPDATE study_partner.study_sessions SET updated_at=now() WHERE id=$1",
        [s.id],
      );
    });
  }
  async run(
    owner: string,
    op: Op,
    s: SessionRow,
    content: string,
    emit: (event: unknown) => void,
    voiceInstruction?: string,
    observe?: (
      event:
        | "dispatched"
        | "first_token"
        | "completed"
        | "cancelled"
        | "failed"
        | "uncertain",
    ) => void,
  ) {
    const provider = this.providerRequired();
    let output = "";
    let dispatched = false;
    try {
      const ctx = await this.context(owner, s.material_id);
      if (!ctx?.assistant_id) failure(409, "AI context is unavailable.");
      if (!s.thread_id) {
        // Mark uncertain before a remote create, so a crash cannot blindly recreate it.
        dispatched = true;
        s.thread_id = await provider.thread(ctx.assistant_id!);
        const saved = await this.pool.query(
          "UPDATE study_partner.study_sessions SET thread_id=$2 WHERE id=$1 RETURNING id",
          [s.id, s.thread_id],
        );
        if (!saved.rowCount) return;
        dispatched = false;
      }
      const baseline = (await provider.messages(s.thread_id)).map(
        (m) => m.message_id,
      );
      await this.pool.query(
        "UPDATE study_partner.ai_operations SET baseline_ids=$2 WHERE id=$1",
        [op.id, JSON.stringify(baseline)],
      );
      const active = (
        await this.pool.query<Op>(
          "SELECT * FROM study_partner.ai_operations WHERE id=$1",
          [op.id],
        )
      ).rows[0];
      if (!active) return;
      if (s.kind === "voice") {
        const live = await this.pool.query(
          "SELECT 1 FROM study_partner.voice_sessions v JOIN study_partner.session a ON a.id=v.auth_session_id WHERE v.id=$1 AND v.status IN ('starting','active') AND v.expires_at>now() AND a.\"expiresAt\">now()",
          [s.id],
        );
        if (!live.rowCount) active.cancel_requested = true;
      }
      if (active.cancel_requested) {
        await this.finish(owner, op, "", true);
        emit({ type: "done" });
        return;
      }
      dispatched = true;
      observe?.("dispatched");
      await this.pool.query(
        "UPDATE study_partner.ai_operations SET dispatched=true WHERE id=$1",
        [op.id],
      );
      for await (const event of provider.generate(
        s.thread_id,
        s.kind === "practice" ? practicePrompt : content,
        s.kind === "practice"
          ? practicePrompt
          : (voiceInstruction ?? instructions[s.mode]),
        s.kind === "practice",
      )) {
        const state = (
          await this.pool.query<Op>(
            "SELECT * FROM study_partner.ai_operations WHERE id=$1",
            [op.id],
          )
        ).rows[0];
        if (!state) {
          if (event.run_id) await provider.cancel(s.thread_id, event.run_id);
          return;
        }
        if (s.kind === "voice") {
          const live = await this.pool.query(
            "SELECT 1 FROM study_partner.voice_sessions v JOIN study_partner.session a ON a.id=v.auth_session_id WHERE v.id=$1 AND v.status IN ('starting','active') AND v.expires_at>now() AND a.\"expiresAt\">now()",
            [s.id],
          );
          if (!live.rowCount) state.cancel_requested = true;
        }
        if (event.run_id || event.message_id)
          await this.pool.query(
            "UPDATE study_partner.ai_operations SET run_id=COALESCE($2,run_id),provider_message_id=COALESCE($3,provider_message_id) WHERE id=$1",
            [op.id, event.run_id ?? null, event.message_id ?? null],
          );
        if (
          s.kind === "voice" &&
          state.cancel_requested &&
          !event.run_id &&
          !state.run_id
        ) {
          // Preparatory events can arrive before run_started. Keep consuming the
          // bounded stream until a run ID lets us confirm cancellation, rather
          // than abandoning a known live request as uncertain on the first event.
          continue;
        }
        if (state.cancel_requested && (event.run_id || state.run_id)) {
          await provider.cancel(s.thread_id, event.run_id ?? state.run_id!);
          await this.finish(owner, op, output, true);
          emit({ type: "done" });
          return;
        }
        if (event.type === "content_streaming" && event.content) {
          if (!output) observe?.("first_token");
          output += event.content;
          if (output.length > 100_000) throw new ProviderError();
          await this.pool.query(
            "UPDATE study_partner.ai_operations SET output=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",
            [op.id, output],
          );
          if (s.kind !== "practice")
            emit({ type: "delta", content: event.content });
        }
        if (
          ["error", "run_failed", "tool_submit_required"].includes(event.type)
        )
          throw new ProviderError(event.type === "run_failed");
        if (event.type === "run_ended") {
          if (event.status && event.status !== "COMPLETED")
            throw new ProviderError();
          if (!output.trim()) throw new ProviderError();
          await this.finish(owner, op, output);
          emit({ type: "done" });
          return;
        }
      }
      throw new ProviderError();
    } catch (error) {
      const definite =
        !dispatched || (error instanceof ProviderError && error.definite);
      await this.pool.query(
        "UPDATE study_partner.ai_operations SET status=$2 WHERE id=$1 AND status='running'",
        [op.id, definite ? "failed" : "uncertain"],
      );
      emit({
        type: "error",
        message:
          error instanceof MaterialError
            ? error.message
            : definite
              ? "AI could not answer. Please try again."
              : "The connection was interrupted. Check for the saved result before retrying.",
      });
    }
  }
  async operation(owner: string, id: string, operationId: string) {
    await this.session(owner, id);
    return (
      await this.pool.query<Op>(
        "SELECT * FROM study_partner.ai_operations WHERE session_id=$1 AND id=$2",
        [id, operationId],
      )
    ).rows[0];
  }
  async recover(owner: string, id: string, operationId?: string) {
    const s = await this.session(owner, id);
    const op = (
      await this.pool.query<Op>(
        "SELECT * FROM study_partner.ai_operations WHERE session_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC LIMIT 1",
        [id, operationId ?? null],
      )
    ).rows[0];
    if (!op || !["running", "uncertain"].includes(op.status))
      return this.detail(owner, id);
    if (op.status === "running" && op.lease_until > new Date())
      return this.detail(owner, id);
    await this.pool.query(
      "UPDATE study_partner.ai_operations SET status='uncertain' WHERE id=$1 AND status='running'",
      [op.id],
    );
    if (s.thread_id && op.dispatched) {
      const messages = await this.providerRequired().messages(s.thread_id);
      const response = messages.find(
        (m) =>
          m.role.toLowerCase() === "assistant" &&
          m.status === "COMPLETED" &&
          !op.baseline_ids.includes(m.message_id) &&
          (!op.provider_message_id || op.provider_message_id === m.message_id),
      );
      if (response?.content) await this.finish(owner, op, response.content);
    }
    return this.detail(owner, id);
  }
  async cancel(owner: string, id: string, operationId?: string) {
    const s = await this.session(owner, id);
    const op = (
      await this.pool.query<Op>(
        "UPDATE study_partner.ai_operations SET cancel_requested=true WHERE session_id=$1 AND ($2::uuid IS NULL OR id=$2) AND status IN ('running','uncertain') RETURNING *",
        [id, operationId ?? null],
      )
    ).rows[0];
    if (op?.run_id && s.thread_id) {
      await this.providerRequired().cancel(s.thread_id, op.run_id);
      await this.finish(owner, op, op.output, true);
    }
    return this.detail(owner, id);
  }
  async answer(owner: string, id: string, position: number, answer: number) {
    const s = await this.session(owner, id);
    if (s.kind !== "practice") failure(404, "Practice not found.");
    await this.transaction(async (db) => {
      await db.query(
        "SELECT id FROM study_partner.study_sessions WHERE id=$1 FOR UPDATE",
        [id],
      );
      const q = (
        await db.query(
          "SELECT * FROM study_partner.practice_questions WHERE session_id=$1 AND position=$2",
          [id, position],
        )
      ).rows[0];
      if (!q) failure(404, "Question not found.");
      if (q.answer !== null) {
        if (q.answer !== answer) failure(409, "This answer is already saved.");
        return;
      }
      const next = (
        await db.query(
          "SELECT min(position) AS position FROM study_partner.practice_questions WHERE session_id=$1 AND answer IS NULL",
          [id],
        )
      ).rows[0].position;
      if (next !== position) failure(409, "Answer the current question first.");
      await db.query(
        "UPDATE study_partner.practice_questions SET answer=$3,answered_at=now() WHERE session_id=$1 AND position=$2",
        [id, position, answer],
      );
      await db.query(
        "UPDATE study_partner.study_sessions SET updated_at=now() WHERE id=$1",
        [id],
      );
    });
    return this.detail(owner, id);
  }
}

export async function cleanupAI(pool: Pool, provider: Backboard) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const jobs = await db.query<{
      context_id: string;
      assistant_id: string | null;
    }>(
      "SELECT * FROM study_partner.ai_cleanup WHERE not_before<now() ORDER BY not_before LIMIT 10 FOR UPDATE SKIP LOCKED",
    );
    for (const job of jobs.rows) {
      try {
        await provider.cleanup(job.context_id, job.assistant_id);
        await db.query(
          "DELETE FROM study_partner.ai_cleanup WHERE context_id=$1",
          [job.context_id],
        );
      } catch {
        await db.query(
          "UPDATE study_partner.ai_cleanup SET attempts=attempts+1,not_before=now()+interval '15 minutes' WHERE context_id=$1",
          [job.context_id],
        );
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
