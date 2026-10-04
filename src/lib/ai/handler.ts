import { z } from "zod";
import { boundedBody } from "../materials/handler";
import { MaterialError, checkMaterialRate } from "../materials/repository";
import { modes } from "./types";
import type { StudyService } from "./service";

export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
type Services = {
  study: StudyService;
  origin: string;
  authenticate(headers: Headers): Promise<string | null>;
};
const startSchema = z
  .object({
    materialId: z.uuid(),
    id: z.uuid(),
    mode: z.enum(modes).optional(),
  })
  .strict();
const sendSchema = z
  .object({ content: z.string().trim().min(1).max(8000), requestKey: z.uuid() })
  .strict();
export async function studyHandler(
  request: Request,
  services: Services,
  path: string[],
) {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: privateHeaders });
  try {
    const owner = await services.authenticate(request.headers);
    if (!owner) throw new MaterialError(401, "Please sign in again.");
    const study = services.study;
    const [area, id, action] = path;
    if (path.length > 3) throw new MaterialError(404, "Not found.");
    if (
      request.method !== "GET" &&
      request.headers.get("origin") !== services.origin
    )
      throw new MaterialError(403, "Invalid request origin.");
    const body = async () => {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new MaterialError(415, "Send a JSON request.");
      try {
        return JSON.parse(
          (await boundedBody(request, 50_000)).toString("utf8"),
        );
      } catch {
        throw new MaterialError(400, "Invalid request.");
      }
    };
    if (area === "materials" && id && action === "ai") {
      if (request.method === "GET") return json(await study.status(owner, id));
      await checkMaterialRate(study.pool, owner);
      if (request.method === "POST") {
        z.object({ consent: z.literal(true) })
          .strict()
          .parse(await body());
        return json(await study.prepare(owner, id));
      }
      if (request.method === "DELETE") {
        await study.reset(owner, id);
        return json({ reset: true, cleanupPending: true });
      }
    }
    if (!["study-sessions", "practice"].includes(area))
      throw new MaterialError(404, "Not found.");
    if (id) {
      const session = await study.session(owner, id);
      if (session.kind === "voice") throw new MaterialError(404, "Use the voice session endpoint.");
      if ((area === "practice") !== (session.kind === "practice"))
        throw new MaterialError(404, "Session not found.");
    }
    if (request.method === "GET") {
      if (id) return json(await study.detail(owner, id));
      return json({
        sessions: await study.history(
          owner,
          new URL(request.url).searchParams.get("materialId") ?? undefined,
        ),
      });
    }
    if (request.method === "POST" && !id) {
      await checkMaterialRate(study.pool, owner);
      const input = startSchema.parse(await body());
      return json(
        await study.createSession(
          owner,
          input.materialId,
          input.id,
          area === "practice" ? "practice" : "study",
          input.mode,
        ),
        201,
      );
    }
    if (request.method === "PATCH" && id) {
      const input = z
        .object({ mode: z.enum(modes) })
        .strict()
        .parse(await body());
      return json(await study.mode(owner, id, input.mode));
    }
    if (request.method === "POST" && id && action === "answers") {
      const input = z
        .object({
          position: z.number().int().min(0).max(4),
          answer: z.number().int().min(0).max(3),
        })
        .strict()
        .parse(await body());
      return json(await study.answer(owner, id, input.position, input.answer));
    }
    if (request.method === "POST" && id && action === "recover")
      return json(await study.recover(owner, id));
    if (request.method === "POST" && id && action === "cancel")
      return json(await study.cancel(owner, id));
    if (request.method === "POST" && id && action === "messages") {
      const input = sendSchema.parse(await body());
      const { op, fresh, session } = await study.reserve(
        owner,
        id,
        input.requestKey,
        input.content,
      );
      if (!fresh) return json(await study.detail(owner, id));
      const encoder = new TextEncoder();
      let connected = true;
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (event: unknown) => {
            if (connected) {
              try {
                controller.enqueue(
                  encoder.encode(`${JSON.stringify(event)}\n`),
                );
              } catch {
                connected = false;
              }
            }
          };
          emit({ type: "start", operationId: op.id });
          try {
            await study.run(owner, op, session, input.content, emit);
          } catch {
            emit({
              type: "error",
              message: "Connection interrupted. Check for the saved result.",
            });
          } finally {
            if (connected) controller.close();
          }
        },
        cancel() {
          connected = false;
        },
      });
      return new Response(stream, {
        headers: {
          ...privateHeaders,
          "Content-Type": "application/x-ndjson",
          "X-Accel-Buffering": "no",
        },
      });
    }
    throw new MaterialError(405, "Method not allowed.");
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        { message: "Invalid request. Messages must be 1 to 8,000 characters." },
        400,
      );
    return json(
      {
        message:
          error instanceof MaterialError
            ? error.message
            : "AI study is temporarily unavailable. Please try again.",
      },
      error instanceof MaterialError ? error.status : 503,
    );
  }
}
