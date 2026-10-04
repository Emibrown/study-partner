import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedBody } from "../materials/handler";
import { MaterialError, checkMaterialRate } from "../materials/repository";
import { privateHeaders } from "../ai/handler";
import { MODEL } from "../ai/backboard";
import { secretEqual, VoiceService, type Identity } from "./service";
import { voiceRoles } from "./types";
import { voiceReference, voiceTrace } from "./trace";
export type VoiceServices = {
  voice: VoiceService;
  origin: string;
  authenticate(headers: Headers): Promise<Identity | null>;
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: privateHeaders });
async function body(request: Request, limit = 50_000) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new MaterialError(415, "Send JSON.");
  try {
    return JSON.parse((await boundedBody(request, limit)).toString("utf8"));
  } catch {
    throw new MaterialError(400, "Invalid request body.");
  }
}
export async function voiceHandler(
  request: Request,
  services: VoiceServices,
  path: string[],
) {
  const { voice } = services;
  try {
    if (path.join("/") === "webhook" && request.method === "POST") {
      const raw = (await boundedBody(request, 2_000_000)).toString("utf8");
      await voice.webhook(
        raw,
        request.headers.get("elevenlabs-signature") ?? "",
      );
      return json({ received: true });
    }
    if (
      path.join("/") === "llm/chat/completions" &&
      request.method === "POST"
    ) {
      const provider = voice.required();
      if (
        !secretEqual(
          request.headers.get("authorization") ?? "",
          `Bearer ${provider.config.ELEVENLABS_LLM_SECRET}`,
        )
      )
        throw new MaterialError(401, "Unauthorized provider request.");
      const input = z
        .object({
          model: z.literal(MODEL),
          stream: z.literal(true),
          messages: z
            .array(
              z.object({
                role: z.enum(["system", "user", "assistant"]),
                content: z.string().max(100_000),
              }),
            )
            .min(1)
            .max(250),
          elevenlabs_extra_body: z.object({
            voice_capability: z.string().max(200),
          }),
        })
        .parse(await body(request, 2_000_000));
      // ElevenLabs may ask for an idle continuation after assistant speech.
      // Authenticate it, but do not bill or replay the latest learner turn.
      if (input.messages.at(-1)?.role !== "user") {
        const idle = await voice.connection(
          input.elevenlabs_extra_body.voice_capability,
        );
        const unresolved = await voice.pool.query(
          "SELECT 1 FROM study_partner.ai_operations WHERE session_id=$1 AND status IN ('running','uncertain')",
          [idle.id],
        );
        if (unresolved.rowCount)
          throw new MaterialError(
            409,
            "The previous voice response is unresolved. End the call and check its saved session.",
          );
        voiceTrace(idle.id)("idle");
        const completed = {
          id: randomUUID(),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: MODEL,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "Take your time. I'm listening.",
              },
              finish_reason: null,
            },
          ],
        };
        return new Response(
          `data: ${JSON.stringify(completed)}\n\ndata: ${JSON.stringify({ ...completed, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          {
            headers: {
              ...privateHeaders,
              "Content-Type": "text/event-stream",
              "X-Accel-Buffering": "no",
            },
          },
        );
      }
      const { row, turn, content } = await voice.bridge(
        input.elevenlabs_extra_body.voice_capability,
        input.messages,
      );
      const encoder = new TextEncoder();
      let connected = true;
      let finished = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const cancel = () => {
        if (finished || !connected) return;
        connected = false;
        clearInterval(heartbeat);
        void voice
          .cancelTurn(row.user_id, row.id, turn.request_key)
          .catch(() => {});
      };
      const stream = new ReadableStream({
        async start(controller) {
          const send = (value: unknown) => {
            if (connected)
              try {
                controller.enqueue(
                  encoder.encode(
                    `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
                  ),
                );
              } catch {
                connected = false;
              }
          };
          const chunk = (content: string, done = false) =>
            send({
              id: turn.request_key,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: MODEL,
              choices: [
                {
                  index: 0,
                  delta: done ? {} : { role: "assistant", content },
                  finish_reason: done ? "stop" : null,
                },
              ],
            });
          request.signal.addEventListener("abort", cancel, { once: true });
          // Establish the SSE stream without speaking filler as a model answer.
          // Heartbeat comments keep proxies alive while generation is pending.
          if (!request.signal.aborted) chunk("");
          else cancel();
          heartbeat = connected
            ? setInterval(() => {
                if (connected) {
                  try {
                    controller.enqueue(encoder.encode(": keep-alive\n\n"));
                  } catch {
                    cancel();
                  }
                }
              }, 2000)
            : undefined;
          try {
            if (connected)
              await voice.generate(row, turn, content, (text) => chunk(text));
            chunk("", true);
            send("[DONE]");
          } catch {
            send({
              error: {
                message:
                  "Voice response could not complete. End the call and check its saved status.",
                type: "voice_generation_error",
                reference: voiceReference(row.id),
              },
            });
          } finally {
            finished = true;
            clearInterval(heartbeat);
            request.signal.removeEventListener("abort", cancel);
            if (connected) controller.close();
          }
        },
        cancel,
      });
      return new Response(stream, {
        headers: {
          ...privateHeaders,
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        },
      });
    }
    const identity = await services.authenticate(request.headers);
    if (!identity) throw new MaterialError(401, "Please sign in again.");
    if (request.method !== "GET") {
      if (request.headers.get("origin") !== services.origin)
        throw new MaterialError(403, "Invalid request origin.");
      // Ending and interruption must remain available after other mutation limits.
      if (!["end", "disconnect", "interrupt"].includes(path[1] ?? ""))
        await checkMaterialRate(voice.pool, identity.userId);
    }
    const [id, action] = path;
    if (path.length > 2) throw new MaterialError(404, "Not found.");
    if (id === "configuration" && request.method === "GET") {
      await voice.required().validate();
      return json({ available: true });
    }
    if (!id && request.method === "GET")
      return json({ sessions: await voice.list(identity.userId) });
    if (!id && request.method === "POST") {
      const input = z
        .object({
          id: z.uuid(),
          materialId: z.uuid(),
          role: z.enum(voiceRoles),
          consent: z.literal(true),
        })
        .strict()
        .parse(await body(request));
      return json(await voice.start(identity, input), 201);
    }
    const row = await voice.row(id, identity.userId);
    if (request.method === "GET" && !action) {
      await voice.expire(identity.userId);
      return json(voice.public(await voice.row(id, identity.userId)));
    }
    if (request.method === "POST") {
      if (action === "bind") {
        const input = z
          .object({ conversationId: z.string().min(1).max(200) })
          .strict()
          .parse(await body(request));
        return json(await voice.bind(row, input.conversationId));
      }
      if (action === "end") return json(await voice.end(identity.userId, id));
      if (action === "disconnect")
        return json(await voice.end(identity.userId, id, true));
      if (action === "reconcile")
        return json(await voice.reconcile(identity.userId, id));
      if (action === "interrupt") {
        const input = z
          .object({ requestKey: z.uuid() })
          .strict()
          .parse(await body(request));
        await voice.cancelTurn(identity.userId, id, input.requestKey);
        return json({ interrupted: true });
      }
    }
    throw new MaterialError(405, "Method not allowed.");
  } catch (error) {
    return json(
      {
        message:
          error instanceof MaterialError
            ? error.message
            : error instanceof z.ZodError
              ? "Invalid voice request or provider configuration."
              : "Voice is temporarily unavailable. Please try again later.",
      },
      error instanceof MaterialError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 503,
    );
  }
}
