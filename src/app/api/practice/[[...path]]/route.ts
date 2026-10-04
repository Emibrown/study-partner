import { handleStudyRequest } from "@/lib/ai/server";
export const runtime = "nodejs";
export const maxDuration = 300;
async function handle(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  return handleStudyRequest(request, [
    "practice",
    ...((await context.params).path ?? []),
  ]);
}
export { handle as GET, handle as POST };
