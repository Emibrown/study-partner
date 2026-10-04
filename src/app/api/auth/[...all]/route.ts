import { getAuthServices } from "@/lib/auth/server";
import { readAuthConfig } from "@/lib/auth/config";
export const runtime = "nodejs";

async function handler(request: Request) {
  if (!readAuthConfig())
    return Response.json(
      {
        code: "AUTH_UNAVAILABLE",
        message: "Sign-in is not configured yet. Please try again later.",
      },
      { status: 503 },
    );
  try {
    return await getAuthServices().auth.handler(request);
  } catch {
    return Response.json(
      {
        code: "AUTH_UNAVAILABLE",
        message: "Authentication is temporarily unavailable. Please try again.",
      },
      { status: 503 },
    );
  }
}
export { handler as GET, handler as POST };
