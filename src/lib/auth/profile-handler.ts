import "server-only";
import { readAuthConfig } from "./config";
import { getAuthServices } from "./server";
import { preferencesSchema, readProfile, saveProfile } from "./preferences";

export async function profileHandler(request: Request, complete = false) {
  const config = readAuthConfig();
  if (!config)
    return Response.json(
      { message: "Authentication is unavailable." },
      { status: 503 },
    );
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !== config.BETTER_AUTH_URL
  )
    return Response.json(
      { message: "Invalid request origin." },
      { status: 403 },
    );
  try {
    const { auth, pool } = getAuthServices();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user.emailVerified)
      return Response.json({ message: "Please sign in." }, { status: 401 });
    if (request.method === "GET")
      return Response.json(await readProfile(pool, session.user.id), {
        headers: { "Cache-Control": "private, no-store" },
      });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return Response.json({ message: "JSON is required." }, { status: 415 });
    const text = await request.text();
    if (text.length > 8192)
      return Response.json(
        { message: "Request is too large." },
        { status: 413 },
      );
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ message: "Invalid request." }, { status: 400 });
    }
    const result = preferencesSchema.safeParse(body);
    if (!result.success)
      return Response.json(
        { message: "Please check your preferences." },
        { status: 400 },
      );
    await saveProfile(pool, session.user.id, result.data, complete);
    return Response.json(
      { success: true },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return Response.json(
      { message: "Your preferences could not be saved. Please try again." },
      { status: 503 },
    );
  }
}
