import { handleStudyRequest } from "@/lib/ai/server";
export const runtime = "nodejs";
export const maxDuration = 300;
async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleStudyRequest(request, [
    "materials",
    (await context.params).id,
    "ai",
  ]);
}
export { handle as GET, handle as POST, handle as DELETE };
