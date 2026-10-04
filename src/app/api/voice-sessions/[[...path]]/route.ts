import { handleVoice } from "@/lib/voice/server";
export const runtime = "nodejs";
export const maxDuration = 300;
async function handle(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  return handleVoice(request, (await context.params).path ?? []);
}
export { handle as GET, handle as POST };
