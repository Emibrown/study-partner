import { handleStudyRequest } from "@/lib/ai/server";
export const runtime = "nodejs";
export const maxDuration = 300;
async function handle(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  return handleStudyRequest(request, [
    "study-sessions",
    ...((await context.params).path ?? []),
  ]);
}
export { handle as GET, handle as POST, handle as PATCH };
