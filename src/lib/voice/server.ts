import "server-only";
import { getAuthServices } from "../auth/server";
import { readAuthConfig } from "../auth/config";
import { createStorage } from "../materials/storage";
import { StudyService } from "../ai/service";
import { Backboard } from "../ai/backboard";
import { privateHeaders } from "../ai/handler";
import { ElevenVoice, readVoiceConfig } from "./elevenlabs";
import { VoiceService } from "./service";
import { voiceHandler } from "./handler";
export async function handleVoice(request: Request, path: string[]) {
  try {
    const config = readAuthConfig();
    if (!config) throw new Error("Unavailable");
    const { auth, pool } = getAuthServices();
    const voiceConfig = readVoiceConfig();
    return await voiceHandler(
      request,
      {
        origin: config.BETTER_AUTH_URL,
        voice: new VoiceService(
          new StudyService(
            pool,
            process.env.BACKBOARD_API_KEY
              ? new Backboard(process.env.BACKBOARD_API_KEY)
              : null,
            createStorage(),
          ),
          voiceConfig ? new ElevenVoice(voiceConfig) : null,
        ),
        async authenticate(headers) {
          const session = await auth.api.getSession({ headers });
          return session?.user.emailVerified
            ? { userId: session.user.id, sessionId: session.session.id }
            : null;
        },
      },
      path,
    );
  } catch {
    return Response.json(
      { message: "Voice is temporarily unavailable." },
      { status: 503, headers: privateHeaders },
    );
  }
}
