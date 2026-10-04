import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import path from "node:path";
import { databaseConnectionString } from "../src/lib/auth/database";
import { cleanupMaterials } from "../src/lib/materials/repository";
import { createStorage } from "../src/lib/materials/storage";
import { Backboard } from "../src/lib/ai/backboard";
import { cleanupAI, StudyService } from "../src/lib/ai/service";
import {
  ElevenVoice,
  readVoiceConfig,
} from "../src/lib/voice/elevenlabs";
import { maintainVoice, VoiceService } from "../src/lib/voice/service";
loadEnvConfig(path.resolve("."));
async function main() {
  const storage = createStorage();
  if (!process.env.DATABASE_URL)
    throw new Error("Configure the database before cleanup.");
  const pool = new Pool({
    connectionString: databaseConnectionString(process.env.DATABASE_URL),
    connectionTimeoutMillis: 5000,
  });
  try {
    await cleanupMaterials(pool, storage);
    const voiceConfig = readVoiceConfig();
    if (voiceConfig && process.env.BACKBOARD_API_KEY)
      await maintainVoice(
        new VoiceService(
          new StudyService(
            pool,
            new Backboard(process.env.BACKBOARD_API_KEY),
            storage,
          ),
          new ElevenVoice(voiceConfig),
        ),
      );
    if (process.env.BACKBOARD_API_KEY)
      await cleanupAI(pool, new Backboard(process.env.BACKBOARD_API_KEY));
    console.log("Material cleanup batch completed (up to 10 records).");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Material cleanup failed. Check storage and database configuration.",
  );
  process.exitCode = 1;
});
