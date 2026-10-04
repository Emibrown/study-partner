import { z } from "zod";
import type { Pool } from "pg";
import { defaultPreferences } from "../fixtures";

export const preferencesSchema = z
  .object({
    goal: z.enum([
      "Understand my notes",
      "Prepare for an exam",
      "Build a study habit",
    ]),
    mode: z.enum(["Explain it back", "Practice questions", "Talk it through"]),
    duration: z.enum(["10 minutes", "20 minutes", "30 minutes"]),
    voice: z.enum([
      "Warm & encouraging",
      "Calm & thoughtful",
      "Direct & focused",
    ]),
    pace: z.enum(["Slower", "Natural", "Faster"]),
    captions: z.boolean(),
    reminders: z.boolean(),
  })
  .strict();
export async function readProfile(pool: Pool, userId: string) {
  const result = await pool.query(
    "SELECT preferences, onboarding_completed_at FROM study_partner.user_preferences WHERE user_id = $1",
    [userId],
  );
  const row = result.rows[0];
  return {
    preferences: row
      ? preferencesSchema.parse(
          Object.fromEntries(
            Object.entries(row.preferences).filter(
              ([key]) => key !== "subject",
            ),
          ),
        )
      : defaultPreferences,
    onboarded: Boolean(row?.onboarding_completed_at),
  };
}
export async function saveProfile(
  pool: Pool,
  userId: string,
  preferences: z.infer<typeof preferencesSchema>,
  complete: boolean,
) {
  await pool.query(
    `INSERT INTO study_partner.user_preferences (user_id, preferences, onboarding_completed_at)
    VALUES ($1, $2::jsonb, CASE WHEN $3 THEN now() ELSE NULL END)
    ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences,
    onboarding_completed_at = CASE WHEN $3 THEN COALESCE(user_preferences.onboarding_completed_at, now()) ELSE user_preferences.onboarding_completed_at END,
    updated_at = now()`,
    [userId, JSON.stringify(preferences), complete],
  );
}
