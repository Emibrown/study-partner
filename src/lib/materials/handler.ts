import { z } from "zod";
import type { Pool } from "pg";
import type { ObjectStorage } from "./storage";
import { MAX_NOTE_CHARS, MAX_PDF_BYTES } from "./types";
import {
  MaterialError,
  checkMaterialRate,
  cleanupMaterials,
  createMaterial,
  deleteMaterial,
  getMaterial,
  listMaterials,
} from "./repository";

export type MaterialServices = {
  pool: Pool;
  storage: ObjectStorage | null;
  origin: string;
  authenticate: (headers: Headers) => Promise<string | null>;
};
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !value.includes("\0"));
const noteSchema = z
  .object({
    title: titleSchema,
    notes: z
      .string()
      .min(1)
      .max(MAX_NOTE_CHARS)
      .refine((value) => value.trim().length > 0 && !value.includes("\0")),
  })
  .strict();

export async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit)
    throw new MaterialError(413, "This material is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new MaterialError(400, "Add a file or paste your notes.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MaterialError(413, "This material is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function materialHandler(
  request: Request,
  services: MaterialServices,
  id?: string,
  content = false,
) {
  try {
    const owner = await services.authenticate(request.headers);
    if (!owner) throw new MaterialError(401, "Please sign in.");
    const { pool, storage } = services;
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: privateHeaders });
    if (request.method !== "GET") {
      if (request.headers.get("origin") !== services.origin)
        throw new MaterialError(403, "Invalid request origin.");
      await checkMaterialRate(pool, owner);
    }
    if (request.method === "GET" && !id)
      return json({
        materials: await listMaterials(pool, owner),
        pdfUploadsAvailable: Boolean(storage),
      });
    if (request.method === "GET" && id) {
      const material = await getMaterial(pool, owner, id);
      if (!content) return json(material.detail);
      if (material.key && !storage)
        throw new MaterialError(503, "PDF storage is temporarily unavailable.");
      const bytes = material.key
        ? await storage!.get(material.key)
        : new TextEncoder().encode(material.detail.notes!);
      return new Response(new Uint8Array(bytes), {
        headers: {
          ...privateHeaders,
          "Content-Type": material.key
            ? "application/pdf"
            : "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="material.${material.key ? "pdf" : "txt"}"`,
          "Content-Security-Policy":
            "sandbox; default-src 'none'; frame-ancestors 'self'",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
    }
    if (request.method === "POST" && !id) {
      const type = request.headers.get("content-type")?.split(";")[0];
      let input:
        { title: string; notes: string } | { title: string; pdf: Uint8Array };
      if (type === "application/json") {
        const bytes = await boundedBody(request, MAX_NOTE_CHARS * 6 + 2048);
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new MaterialError(400, "Enter valid notes and a title.");
        }
        const result = noteSchema.safeParse(raw);
        if (!result.success)
          throw new MaterialError(
            400,
            "Add a title (up to 120 characters) and notes (up to 100,000 characters).",
          );
        input = result.data;
      } else if (type === "application/pdf") {
        if (!storage)
          throw new MaterialError(
            503,
            "PDF uploads are not configured yet. You can paste notes instead.",
          );
        let title: string;
        try {
          title = decodeURIComponent(
            request.headers.get("x-material-title") ?? "",
          );
        } catch {
          throw new MaterialError(400, "Invalid material title.");
        }
        const result = titleSchema.safeParse(title);
        if (!result.success)
          throw new MaterialError(400, "Add a title of up to 120 characters.");
        const pdf = await boundedBody(request, MAX_PDF_BYTES);
        if (
          !/^%PDF-\d\.\d/.test(pdf.subarray(0, 8).toString("ascii")) ||
          !pdf.subarray(-1024).includes(Buffer.from("%%EOF"))
        )
          throw new MaterialError(400, "Choose a valid PDF file.");
        input = { title: result.data, pdf };
        await cleanupMaterials(pool, storage, owner, 1);
      } else
        throw new MaterialError(
          415,
          "Only PDF files and pasted notes are supported.",
        );
      return json(await createMaterial(pool, storage, owner, input), 201);
    }
    if (request.method === "DELETE" && id)
      return json({
        deleted: true,
        cleanupPending: await deleteMaterial(pool, storage, owner, id),
      });
    throw new MaterialError(405, "Method not allowed.");
  } catch (error) {
    const known = error instanceof MaterialError;
    return Response.json(
      {
        message: known
          ? error.message
          : "Materials are temporarily unavailable. Please try again.",
      },
      {
        status: known ? error.status : 503,
        headers: {
          ...privateHeaders,
          ...(known && error.status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  }
}
