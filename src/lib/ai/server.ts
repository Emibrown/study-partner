import "server-only";
import { getAuthServices } from "../auth/server";
import { readAuthConfig } from "../auth/config";
import { createStorage } from "../materials/storage";
import { Backboard } from "./backboard";
import { StudyService } from "./service";
import { privateHeaders, studyHandler } from "./handler";
export async function handleStudyRequest(request: Request, path: string[]) {
  try {
    const config = readAuthConfig();
    if (!config) throw new Error("Unavailable");
    const { auth, pool } = getAuthServices();
    return await studyHandler(
      request,
      {
        origin: config.BETTER_AUTH_URL,
        study: new StudyService(
          pool,
          process.env.BACKBOARD_API_KEY
            ? new Backboard(process.env.BACKBOARD_API_KEY)
            : null,
          createStorage(),
        ),
        async authenticate(headers) {
          const session = await auth.api.getSession({ headers });
          return session?.user.emailVerified ? session.user.id : null;
        },
      },
      path,
    );
  } catch {
    return Response.json(
      { message: "AI study is temporarily unavailable." },
      { status: 503, headers: privateHeaders },
    );
  }
}
