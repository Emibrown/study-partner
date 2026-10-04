import "server-only";
import { getAuthServices } from "../auth/server";
import { readAuthConfig } from "../auth/config";
import { createStorage } from "./storage";
import { materialHandler } from "./handler";

export async function handleMaterialRequest(
  request: Request,
  id?: string,
  content = false,
) {
  try {
    const config = readAuthConfig();
    if (!config) throw new Error("Missing auth config");
    const { auth, pool } = getAuthServices();
    return await materialHandler(
      request,
      {
        pool,
        storage: createStorage(),
        origin: config.BETTER_AUTH_URL,
        async authenticate(headers) {
          const session = await auth.api.getSession({ headers });
          return session?.user.emailVerified ? session.user.id : null;
        },
      },
      id,
      content,
    );
  } catch {
    return Response.json(
      { message: "Materials are temporarily unavailable. Please try again." },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
