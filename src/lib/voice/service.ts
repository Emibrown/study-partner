import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { MaterialError } from "../materials/repository";
import { readProfile } from "../auth/preferences";
import type { Preferences } from "../fixtures";
import { StudyService } from "../ai/service";
import {
  ElevenVoice,
  type RemoteConversation,
  conversationSchema,
} from "./elevenlabs";
import type { VoiceRole, VoiceSession, VoiceEntry } from "./types";
import { voiceReference, voiceTrace } from "./trace";
import { diagnosticSelected, DIAGNOSTIC_NOTES } from "./diagnostic";
import { getMaterial } from "../materials/repository";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function secretEqual(a: string, b: string) {
  const x = Buffer.from(hash(a)),
    y = Buffer.from(hash(b));
  return timingSafeEqual(x, y);
}
type Row = {
  id: string;
  material_id: string;
  user_id: string;
  alias: string;
  capability_hash: string;
  auth_session_id: string;
  provider_id: string | null;
  status: VoiceSession["status"];
  created_at: Date;
  expires_at: Date;
  connected_at: Date | null;
  ended_at: Date | null;
  preferences: Preferences;
  transcript: VoiceEntry[];
  transcript_final: boolean;
  interrupted: boolean;
  mode: VoiceRole;
  title: string;
};
export type Identity = { userId: string; sessionId: string };
type Turn = {
  position: number;
  request_key: string;
  content_hash: string;
  response: string;
  status: string;
};
export class VoiceService {
  constructor(
    public study: StudyService,
    public provider: ElevenVoice | null,
  ) {}
  get pool() {
    return this.study.pool;
  }
  required() {
    if (!this.provider || !this.study.provider)
      throw new MaterialError(
        503,
        "Voice requires ElevenLabs and Backboard configuration. See VOICE.md.",
      );
    return this.provider;
  }
  async row(id: string, owner?: string) {
    if (!z.uuid().safeParse(id).success)
      throw new MaterialError(404, "Voice session not found.");
    const row = (
      await this.pool.query<Row>(
        "SELECT v.*,s.mode,m.title FROM study_partner.voice_sessions v JOIN study_partner.study_sessions s ON s.id=v.id JOIN study_partner.materials m ON m.id=v.material_id WHERE v.id=$1 AND ($2::text IS NULL OR v.user_id=$2) AND m.state='ready'",
        [id, owner ?? null],
      )
    ).rows[0];
    if (!row) throw new MaterialError(404, "Voice session not found.");
    return row;
  }
  public(row: Row): VoiceSession {
    return {
      diagnosticReference: voiceReference(row.id),
      id: row.id,
      materialId: row.material_id,
      role: row.mode,
      title: row.title,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      connectedAt: row.connected_at?.toISOString() ?? null,
      transcript: row.transcript,
      transcriptFinal: row.transcript_final,
      interrupted: row.interrupted || row.status === "failed",
    };
  }
  async authorized(row: Row) {
    const auth = await this.pool.query(
      'SELECT 1 FROM study_partner.session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',
      [row.auth_session_id, row.user_id],
    );
    if (
      !auth.rowCount ||
      row.expires_at <= new Date() ||
      !["starting", "active"].includes(row.status)
    )
      throw new MaterialError(403, "This voice session has ended or expired.");
  }
  async expire(owner?: string) {
    const rows = await this.pool.query<{ id: string; user_id: string }>(
      `UPDATE study_partner.voice_sessions v SET status='ending',interrupted=(expires_at>now()),ended_at=COALESCE(ended_at,now()) WHERE status IN ('starting','active','uncertain') AND ($1::text IS NULL OR user_id=$1) AND (expires_at<=now() OR NOT EXISTS(SELECT 1 FROM study_partner.session s WHERE s.id=v.auth_session_id AND s."expiresAt">now())) RETURNING id,user_id`,
      [owner ?? null],
    );
    for (const row of rows.rows)
      await this.study.cancel(row.user_id, row.id).catch(() => {});
  }
  async list(owner: string) {
    await this.expire(owner);
    return (
      await this.pool.query<{ id: string }>(
        "SELECT id FROM study_partner.voice_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [owner],
      )
    ).rows;
  }
  async start(
    identity: Identity,
    input: { id: string; materialId: string; role: VoiceRole },
  ) {
    const provider = this.required();
    await provider.validate();
    await this.expire(identity.userId);
    const preferences = (await readProfile(this.pool, identity.userId))
      .preferences;
    const capability = `${input.id}.${randomBytes(32).toString("base64url")}`;
    const alias = randomUUID();
    await this.study.transaction(async (db) => {
      await db.query(
        'SELECT id FROM study_partner."user" WHERE id=$1 FOR UPDATE',
        [identity.userId],
      );
      const material = await db.query(
        "SELECT a.material_id FROM study_partner.material_ai a JOIN study_partner.materials m ON m.id=a.material_id WHERE a.material_id=$1 AND m.user_id=$2 AND m.state='ready' AND a.status='ready' FOR UPDATE OF a",
        [input.materialId, identity.userId],
      );
      if (!material.rowCount)
        throw new MaterialError(
          404,
          "Prepare your own material for AI study first.",
        );
      if (
        (
          await db.query(
            "SELECT 1 FROM study_partner.voice_starts WHERE id=$1",
            [input.id],
          )
        ).rowCount
      )
        throw new MaterialError(
          409,
          "This call was already requested. Open its saved session; it will not be started twice.",
        );
      const existing = await db.query(
        "SELECT 1 FROM study_partner.voice_sessions WHERE (user_id=$1 OR material_id=$2) AND status IN ('starting','active','uncertain')",
        [identity.userId, input.materialId],
      );
      if (existing.rowCount)
        throw new MaterialError(
          409,
          "End or recover the active session before starting a voice call.",
        );
      const generation = await db.query(
        "SELECT status FROM study_partner.ai_operations WHERE material_id=$1 AND status IN ('running','uncertain')",
        [input.materialId],
      );
      if (generation.rowCount)
        throw new MaterialError(
          409,
          generation.rows.some((row) => row.status === "uncertain")
            ? "An earlier AI response for this material is unresolved, even though the call may have ended. Open its saved session to check recovery, or choose another prepared material. Your existing data has been preserved."
            : "An AI response for this material is still running. Wait for it to finish or stop it from its study session before starting a voice call.",
        );
      await db.query(
        "INSERT INTO study_partner.study_sessions(id,material_id,kind,mode) VALUES($1,$2,'voice',$3)",
        [input.id, input.materialId, input.role],
      );
      await db.query(
        "INSERT INTO study_partner.voice_sessions(id,user_id,material_id,alias,capability_hash,auth_session_id,status,preferences) VALUES($1,$2,$3,$4,$5,$6,'starting',$7)",
        [
          input.id,
          identity.userId,
          input.materialId,
          alias,
          hash(capability),
          identity.sessionId,
          JSON.stringify(preferences),
        ],
      );
      await db.query(
        "INSERT INTO study_partner.voice_starts(id,user_id) VALUES($1,$2)",
        [input.id, identity.userId],
      );
    });
    try {
      const token = await provider.token(alias);
      await this.pool.query(
        "UPDATE study_partner.voice_sessions SET provider_id=$2 WHERE id=$1 AND provider_id IS NULL",
        [input.id, token.conversationId],
      );
      const row = await this.row(input.id, identity.userId);
      await this.authorized(row);
      return {
        session: this.public(row),
        conversationToken: token.token,
        capability,
        alias,
        speed:
          preferences.pace === "Slower"
            ? 0.9
            : preferences.pace === "Faster"
              ? 1.1
              : 1,
      };
    } catch {
      await this.pool.query(
        "UPDATE study_partner.voice_sessions SET status='uncertain' WHERE id=$1 AND status='starting'",
        [input.id],
      );
      throw new MaterialError(
        503,
        "The call could not be confirmed. Check the saved session before trying again.",
      );
    }
  }
  matches(
    row: Pick<Row, "alias" | "capability_hash"> & {
      provider_id?: string | null;
    },
    remote: RemoteConversation,
  ) {
    const capability =
      remote.conversation_initiation_client_data?.custom_llm_extra_body
        ?.voice_capability;
    const bound = row.provider_id === remote.conversation_id;
    const alias =
      remote.user_id ?? remote.conversation_initiation_client_data?.user_id;
    return (
      remote.agent_id === this.required().config.ELEVENLABS_AGENT_ID &&
      (alias === row.alias || (alias == null && bound)) &&
      (capability == null
        ? bound
        : typeof capability === "string" &&
          secretEqual(hash(capability), row.capability_hash))
    );
  }
  async bind(row: Row, id: string) {
    if (row.provider_id && row.provider_id !== id)
      throw new MaterialError(403, "Voice connection could not be verified.");
    // WebRTC connects before initiation metadata is necessarily readable by REST.
    // Retry reads only; never issue another token or relax identity verification.
    let verified = false;
    for (const wait of [0, 250, 500, 1000]) {
      if (wait) await delay(wait);
      row = await this.row(row.id, row.user_id);
      await this.authorized(row);
      if (row.provider_id && row.provider_id !== id)
        throw new MaterialError(403, "Voice connection could not be verified.");
      if (row.provider_id === id) {
        verified = true;
        break;
      }
      try {
        const remote = await this.required().conversation(id);
        if (this.matches(row, remote)) {
          verified = true;
          break;
        }
        const initiation = remote.conversation_initiation_client_data;
        const alias = remote.user_id ?? initiation?.user_id;
        const capability = initiation?.custom_llm_extra_body?.voice_capability;
        if (
          remote.agent_id !== this.required().config.ELEVENLABS_AGENT_ID ||
          (alias != null && alias !== row.alias) ||
          (capability != null &&
            (typeof capability !== "string" ||
              !secretEqual(hash(capability), row.capability_hash)))
        )
          throw new MaterialError(
            403,
            "Voice connection could not be verified.",
          );
      } catch (error) {
        if (!(error instanceof MaterialError) || error.status !== 503)
          throw error;
      }
    }
    if (!verified)
      throw new MaterialError(
        503,
        "ElevenLabs has not made the voice connection details available for verification. The call will end; check its saved session before starting again.",
      );
    await this.authorized(row);
    const saved = await this.pool.query(
      "UPDATE study_partner.voice_sessions SET provider_id=$2,status='active',connected_at=COALESCE(connected_at,now()) WHERE id=$1 AND status IN ('starting','active') AND (provider_id IS NULL OR provider_id=$2) RETURNING id",
      [row.id, id],
    );
    if (!saved.rowCount)
      throw new MaterialError(409, "Voice session is no longer available.");
    voiceTrace(row.id)("connected");
    return this.public(await this.row(row.id, row.user_id));
  }
  async discover(row: Row) {
    if (row.provider_id) return row.provider_id;
    const candidates = await this.required().find(row.alias);
    if (candidates.length !== 1)
      throw new MaterialError(
        503,
        "The voice connection is not confirmed yet.",
      );
    const remote = await this.required().conversation(
      candidates[0].conversation_id,
    );
    if (!this.matches(row, remote))
      throw new MaterialError(403, "Voice connection could not be verified.");
    await this.pool.query(
      "UPDATE study_partner.voice_sessions SET provider_id=$2 WHERE id=$1 AND provider_id IS NULL",
      [row.id, remote.conversation_id],
    );
    return remote.conversation_id;
  }
  async end(owner: string, id: string, interrupted = false) {
    voiceTrace(id)("disconnected");
    const row = await this.row(id, owner);
    await this.pool.query(
      "UPDATE study_partner.voice_sessions SET status=CASE WHEN status IN ('ended','failed') THEN status ELSE 'ending' END,interrupted=CASE WHEN ended_at IS NULL THEN $2 ELSE interrupted END,ended_at=COALESCE(ended_at,now()) WHERE id=$1",
      [id, interrupted],
    );
    await this.study.cancel(owner, id).catch(() => {});
    // The client disconnects transport; the provider's hard duration limit also applies.
    return this.public(await this.row(row.id, owner));
  }
  async reconcile(owner: string, id: string) {
    await this.expire(owner);
    const row = await this.row(id, owner);
    const providerId = await this.discover(row);
    await this.applyTranscript(await this.required().conversation(providerId));
    return this.public(await this.row(id, owner));
  }
  async applyTranscript(remote: RemoteConversation) {
    const alias =
      remote.user_id ?? remote.conversation_initiation_client_data?.user_id;
    if (
      !alias ||
      !z.uuid().safeParse(alias).success ||
      remote.agent_id !== this.required().config.ELEVENLABS_AGENT_ID
    )
      return;
    await this.study.transaction(async (db) => {
      const row = (
        await db.query<Row>(
          "SELECT * FROM study_partner.voice_sessions WHERE alias=$1 FOR UPDATE",
          [alias],
        )
      ).rows[0];
      if (!row) {
        await db.query(
          "UPDATE study_partner.voice_cleanup SET provider_id=$2 WHERE alias=$1 AND provider_id IS NULL",
          [alias, remote.conversation_id],
        );
        return;
      }
      if (
        !this.matches(row, remote) ||
        (row.provider_id && row.provider_id !== remote.conversation_id)
      )
        throw new MaterialError(403, "Voice transcript could not be verified.");
      if (!["done", "failed"].includes(remote.status)) return;
      const transcript = remote.transcript
        .filter((t) => t.message)
        .map((t) => ({
          role: t.role,
          message: t.message!,
          time: t.time_in_call_secs,
        }));
      await db.query(
        "UPDATE study_partner.voice_sessions SET provider_id=$2,transcript=$3,transcript_final=true,status=$4,ended_at=COALESCE(ended_at,now()) WHERE id=$1",
        [
          row.id,
          remote.conversation_id,
          JSON.stringify(transcript),
          remote.status === "done" ? "ended" : "failed",
        ],
      );
      await db.query(
        "UPDATE study_partner.study_sessions SET updated_at=now() WHERE id=$1",
        [row.id],
      );
    });
  }
  async webhook(raw: string, signature: string) {
    const provider = this.required();
    const event = z
      .object({ type: z.string(), data: z.unknown() })
      .parse(await provider.webhook(raw, signature));
    if (event.type !== "post_call_transcription") return;
    const digest = hash(raw);
    if (
      (
        await this.pool.query(
          "SELECT 1 FROM study_partner.voice_webhook_receipts WHERE digest=$1",
          [digest],
        )
      ).rowCount
    )
      return;
    await this.applyTranscript(conversationSchema.parse(event.data));
    await this.pool.query(
      "INSERT INTO study_partner.voice_webhook_receipts(digest) VALUES($1) ON CONFLICT DO NOTHING",
      [digest],
    );
  }
  async connection(capability: string) {
    const id = capability.split(".")[0];
    const row = await this.row(id);
    if (!secretEqual(row.capability_hash, hash(capability)))
      throw new MaterialError(403, "Invalid voice capability.");
    await this.authorized(row);
    const providerId = await this.discover(row);
    if (row.provider_id === null) await this.bind(row, providerId);
    return row;
  }
  async bridge(
    capability: string,
    messages: { role: string; content: string }[],
  ) {
    const row = await this.connection(capability);
    const id = row.id;
    const users = messages.filter((m) => m.role === "user");
    const last = users.at(-1);
    if (
      !last ||
      messages.at(-1)?.role !== "user" ||
      !last.content.trim() ||
      last.content.length > 8000
    )
      throw new MaterialError(
        400,
        "A learner turn of up to 8,000 characters is required.",
      );
    const contentHash = hash(JSON.stringify(users));
    const turn = await this.study.transaction(async (db) => {
      await db.query(
        "SELECT id FROM study_partner.voice_sessions WHERE id=$1 FOR UPDATE",
        [id],
      );
      const prior = (
        await db.query<Turn>(
          "SELECT * FROM study_partner.voice_turns WHERE session_id=$1 AND content_hash=$2 ORDER BY position DESC LIMIT 1",
          [id, contentHash],
        )
      ).rows[0];
      if (prior) return prior;
      const pending = await db.query(
        "SELECT 1 FROM study_partner.voice_turns WHERE session_id=$1 AND status='pending'",
        [id],
      );
      if (pending.rowCount)
        throw new MaterialError(409, "The previous voice turn needs recovery.");
      // Speech recognition can revise an utterance after interruption without
      // adding a user message. Persist each distinct request; exact retries above
      // reuse their original operation even if newer revisions already exist.
      const position = Number(
        (
          await db.query(
            "SELECT COALESCE(MAX(position),0)+1 AS next FROM study_partner.voice_turns WHERE session_id=$1",
            [id],
          )
        ).rows[0].next,
      );
      return (
        await db.query<Turn>(
          "INSERT INTO study_partner.voice_turns(session_id,position,request_key,content_hash) VALUES($1,$2,$3,$4) RETURNING *",
          [id, position, randomUUID(), contentHash],
        )
      ).rows[0];
    });
    return { row: await this.row(id), turn, content: last.content };
  }
  async generate(
    row: Row,
    turn: Turn,
    content: string,
    emit: (text: string) => void,
  ) {
    const trace = voiceTrace(row.id, turn.request_key);
    trace("provider_request");
    if (turn.status === "completed") {
      emit(turn.response);
      return;
    }
    if (turn.status !== "pending")
      throw new MaterialError(409, "This turn ended and will not be replayed.");
    const reserve = async () => {
      // A provider interruption closes the old HTTP stream before cancellation
      // is acknowledged. Wait only for that exact session's cancellation; never
      // replay a provider request or release an uncertain material reservation.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const cancelling = await this.pool.query(
          "SELECT id FROM study_partner.ai_operations WHERE session_id=$1 AND request_key<>$2 AND status='running' AND cancel_requested=true",
          [row.id, turn.request_key],
        );
        if (!cancelling.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await this.authorized(row);
      return this.study.reserve(
        row.user_id,
        row.id,
        turn.request_key,
        content,
        row.id,
      );
    };
    let reservation;
    try {
      reservation = await reserve();
    } catch (error) {
      // No operation means no billable dispatch took place. Do not leave this
      // turn blocking future utterances; existing/uncertain operations stay put.
      await this.pool.query(
        "UPDATE study_partner.voice_turns SET status='failed' WHERE session_id=$1 AND request_key=$2 AND status='pending' AND NOT EXISTS (SELECT 1 FROM study_partner.ai_operations WHERE session_id=$1 AND request_key=$2)",
        [row.id, turn.request_key],
      );
      trace("failed");
      throw error;
    }
    const { op, session, fresh } = reservation;
    const latestTurn = (
      await this.pool.query(
        "SELECT status FROM study_partner.voice_turns WHERE session_id=$1 AND request_key=$2",
        [row.id, turn.request_key],
      )
    ).rows[0];
    if (latestTurn?.status !== "pending") {
      await this.study.cancel(row.user_id, row.id, op.id);
      if (fresh) await this.study.finish(row.user_id, op, "", true);
      trace("cancelled");
      return;
    }
    if (!fresh) {
      await this.study.recover(row.user_id, row.id, op.id);
      const saved = await this.study.operation(row.user_id, row.id, op.id);
      if (saved?.status !== "completed")
        throw new MaterialError(
          409,
          "This voice turn is still unresolved. It has not been resent.",
        );
      const response = saved.output;
      if (!response)
        throw new MaterialError(409, "The saved voice response is not ready.");
      await this.pool.query(
        "UPDATE study_partner.voice_turns SET response=$3,status='completed' WHERE session_id=$1 AND position=$2 AND status='pending'",
        [row.id, turn.position, response],
      );
      emit(response);
      return;
    }
    let response = "",
      failed = false;
    if (diagnosticSelected(row.id, row.user_id)) {
      const source = await getMaterial(this.pool, row.user_id, row.material_id);
      if (source.detail.notes !== DIAGNOSTIC_NOTES) {
        await this.study.finish(row.user_id, op, "", true);
        throw new MaterialError(
          409,
          "Diagnostic sessions require the exact fictional study note from VOICE.md.",
        );
      }
      trace("diagnostic");
      response =
        "The battery stores energy in the fictional solar cart. What does the motor do?";
      emit(response);
      await this.study.finish(row.user_id, op, response);
    } else {
      const role =
        row.mode === "Classmate"
          ? "Act as a curious classmate: invite discussion and explanations, ask one question at a time, and give supportive material-grounded feedback."
          : "Act as a mock examiner: ask one question at a time, wait for the learner, then give concise material-grounded feedback. Never invent scores.";
      const instruction = `${role} Speaking style: ${row.preferences.voice}. Use short spoken sentences, no markdown or invented citations. Earlier generated replies may have been interrupted; never assume the learner heard them. Only this new learner turn is being sent; use the existing thread and material context.`;
      await this.study.run(
        row.user_id,
        op,
        session,
        content,
        (event) => {
          const e = event as { type: string; content?: string };
          if (e.type === "delta" && e.content) {
            response += e.content;
            emit(e.content);
          }
          if (e.type === "error") failed = true;
        },
        instruction,
        trace,
      );
    }
    const saved = await this.study.operation(row.user_id, row.id, op.id);
    const status = saved?.status;
    if (failed || status !== "completed") {
      if (["failed", "cancelled"].includes(status))
        await this.pool.query(
          "UPDATE study_partner.voice_turns SET status=$3 WHERE session_id=$1 AND position=$2",
          [
            row.id,
            turn.position,
            status === "cancelled" ? "interrupted" : "failed",
          ],
        );
      // Cancellation is expected when the learner interrupts; it is not an LLM
      // outage. Finish the current stream without fabricating an answer.
      if (status === "cancelled") {
        trace("cancelled");
        return;
      }
      trace(status === "uncertain" ? "uncertain" : "failed");
      throw new MaterialError(
        503,
        "Voice generation was interrupted or could not complete.",
      );
    }
    await this.pool.query(
      "UPDATE study_partner.voice_turns SET response=$3,status='completed' WHERE session_id=$1 AND position=$2 AND status='pending'",
      [row.id, turn.position, response],
    );
    trace("completed");
  }
  async cancelTurn(owner: string, id: string, key: string) {
    await this.row(id, owner);
    voiceTrace(id, key)("stream_closed");
    // Mark just this turn before cancellation, including a close before reserve.
    await this.pool.query(
      "UPDATE study_partner.voice_turns SET status='interrupted' WHERE session_id=$1 AND request_key=$2 AND status='pending'",
      [id, key],
    );
    const op = (
      await this.pool.query(
        "SELECT id FROM study_partner.ai_operations WHERE session_id=$1 AND request_key=$2",
        [id, key],
      )
    ).rows[0];
    if (op) await this.study.cancel(owner, id, op.id);
  }
  async interrupt(owner: string, id: string) {
    await this.row(id, owner);
    await this.study.cancel(owner, id);
    await this.pool.query(
      "UPDATE study_partner.voice_turns SET status='interrupted' WHERE session_id=$1 AND status='pending'",
      [id],
    );
  }
}

export async function maintainVoice(service: VoiceService) {
  await service.expire();
  const candidates = await service.pool.query<{ id: string; user_id: string }>(
    "SELECT id,user_id FROM study_partner.voice_sessions WHERE status IN ('ending','uncertain') AND transcript_final=false ORDER BY created_at LIMIT 10",
  );
  for (const row of candidates.rows)
    await service.reconcile(row.user_id, row.id).catch(() => {});
  const provider = service.required();
  await service.study.transaction(async (db) => {
    const jobs = await db.query<{ alias: string; provider_id: string | null }>(
      "SELECT * FROM study_partner.voice_cleanup WHERE not_before<now() LIMIT 10 FOR UPDATE SKIP LOCKED",
    );
    for (const job of jobs.rows) {
      try {
        const ids = job.provider_id
          ? [job.provider_id]
          : (await provider.find(job.alias)).map((c) => c.conversation_id);
        if (!ids.length) throw new Error("Unresolved provider outcome");
        for (const id of ids) await provider.remove(id);
        await db.query(
          "DELETE FROM study_partner.voice_cleanup WHERE alias=$1",
          [job.alias],
        );
      } catch {
        await db.query(
          "UPDATE study_partner.voice_cleanup SET attempts=attempts+1,not_before=now()+interval '15 minutes' WHERE alias=$1",
          [job.alias],
        );
      }
    }
  });
}
