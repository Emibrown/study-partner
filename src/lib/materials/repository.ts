import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ObjectStorage } from "./storage";
import type { Material, MaterialDetail } from "./types";

export class MaterialError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Row = {
  id: string;
  title: string;
  kind: "PDF" | "Notes";
  byte_size: string;
  created_at: Date;
  notes: string | null;
  object_key: string | null;
};
const summary = (row: Row): Material => ({
  id: row.id,
  title: row.title,
  kind: row.kind,
  byteSize: Number(row.byte_size),
  createdAt: row.created_at.toISOString(),
});
export async function listMaterials(pool: Pool, owner: string) {
  const result = await pool.query<Row>(
    "SELECT id, title, kind, byte_size, created_at FROM study_partner.materials WHERE user_id = $1 AND state = 'ready' ORDER BY created_at DESC, id",
    [owner],
  );
  return result.rows.map(summary);
}
export async function getMaterial(pool: Pool, owner: string, id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new MaterialError(404, "Material not found.");
  const result = await pool.query<Row>(
    "SELECT * FROM study_partner.materials WHERE id = $1 AND user_id = $2 AND state = 'ready'",
    [id, owner],
  );
  const row = result.rows[0];
  if (!row) throw new MaterialError(404, "Material not found.");
  return {
    detail: { ...summary(row), notes: row.notes } as MaterialDetail,
    key: row.object_key,
  };
}
export async function checkMaterialRate(pool: Pool, owner: string) {
  const result = await pool.query(
    `INSERT INTO study_partner.material_rate_limits (user_id, window_start, attempts) VALUES ($1, now(), 1)
    ON CONFLICT (user_id) DO UPDATE SET attempts = CASE WHEN material_rate_limits.window_start < now() - interval '1 minute' THEN 1 ELSE material_rate_limits.attempts + 1 END,
    window_start = CASE WHEN material_rate_limits.window_start < now() - interval '1 minute' THEN now() ELSE material_rate_limits.window_start END RETURNING attempts`,
    [owner],
  );
  if (result.rows[0].attempts > 10)
    throw new MaterialError(
      429,
      "Too many changes. Please wait a minute and try again.",
    );
}
export async function createMaterial(
  pool: Pool,
  storage: ObjectStorage | null,
  owner: string,
  input: { title: string; notes: string } | { title: string; pdf: Uint8Array },
) {
  const pdf = "pdf" in input ? input.pdf : null;
  if (pdf && !storage)
    throw new MaterialError(
      503,
      "PDF uploads are not configured yet. You can paste notes instead.",
    );
  const id = randomUUID();
  const key = pdf ? `materials/${randomUUID()}.pdf` : null;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Serialize reservations for one owner, including in-flight uploads and pending cleanup.
    await db.query(
      'SELECT id FROM study_partner."user" WHERE id = $1 FOR UPDATE',
      [owner],
    );
    const quota = (
      await db.query(
        "SELECT count(*)::int AS count, COALESCE(sum(byte_size), 0)::bigint AS bytes FROM study_partner.materials WHERE user_id = $1",
        [owner],
      )
    ).rows[0];
    if (
      quota.count >= 100 ||
      Number(quota.bytes) + (pdf?.byteLength ?? 0) > 500 * 1024 * 1024
    )
      throw new MaterialError(
        409,
        "Your material storage is full. Delete some materials before adding more.",
      );
    await db.query(
      "INSERT INTO study_partner.materials (id, user_id, title, kind, notes, object_key, byte_size, state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        id,
        owner,
        input.title,
        pdf ? "PDF" : "Notes",
        "notes" in input ? input.notes : null,
        key,
        pdf?.byteLength ?? 0,
        pdf ? "uploading" : "ready",
      ],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  if (pdf && key && storage) {
    try {
      await storage.put(key, pdf);
      const result = await pool.query(
        "UPDATE study_partner.materials SET state = 'ready', updated_at = now() WHERE id = $1 AND state = 'uploading'",
        [id],
      );
      if (result.rowCount !== 1) throw new Error("Upload reservation expired.");
    } catch {
      // A timed-out PUT may still complete remotely. Keep the reservation for the
      // stale-upload cleanup pass instead of racing a late write with a DELETE.
      await pool.query(
        "UPDATE study_partner.materials SET state = 'uploading', updated_at = now() WHERE id = $1",
        [id],
      );
      throw new MaterialError(
        503,
        "The PDF could not be saved. Please try again.",
      );
    }
  }
  return (await getMaterial(pool, owner, id)).detail;
}
export async function deleteMaterial(
  pool: Pool,
  storage: ObjectStorage | null,
  owner: string,
  id: string,
) {
  const { key } = await getMaterial(pool, owner, id);
  const db = await pool.connect();
  let aiPending = false;
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT id FROM study_partner.materials WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [id, owner],
    );
    aiPending = Boolean(
      (
        await db.query(
          "SELECT 1 FROM study_partner.material_ai WHERE material_id=$1",
          [id],
        )
      ).rowCount,
    );
    // The state trigger clears local AI data and queues remote cleanup atomically.
    await db.query(
      "UPDATE study_partner.materials SET state='deleting',updated_at=now() WHERE id=$1 AND user_id=$2",
      [id, owner],
    );
    if (!key)
      await db.query(
        "DELETE FROM study_partner.materials WHERE id=$1 AND user_id=$2",
        [id, owner],
      );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  if (!key) return aiPending;
  await cleanupMaterials(pool, storage, owner, 1);
  return (
    aiPending ||
    Boolean(
      (
        await pool.query(
          "SELECT id FROM study_partner.materials WHERE id = $1",
          [id],
        )
      ).rowCount,
    )
  );
}
export async function cleanupMaterials(
  pool: Pool,
  storage: ObjectStorage | null,
  owner?: string,
  limit = 10,
) {
  if (!storage) return;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const rows = await db.query<{ id: string; object_key: string }>(
      `SELECT id, object_key FROM study_partner.materials
      WHERE (state = 'deleting' OR (state = 'uploading' AND updated_at < now() - interval '1 hour'))
      AND ($1::text IS NULL OR user_id = $1) ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [owner ?? null, limit],
    );
    for (const row of rows.rows) {
      try {
        await storage.delete(row.object_key);
      } catch {
        await db.query(
          "UPDATE study_partner.materials SET state = 'deleting', cleanup_attempts = cleanup_attempts + 1, updated_at = now() WHERE id = $1",
          [row.id],
        );
        continue;
      }
      await db.query("DELETE FROM study_partner.materials WHERE id = $1", [
        row.id,
      ]);
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
